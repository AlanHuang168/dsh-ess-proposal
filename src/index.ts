import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import OpenAI from 'openai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import dotenv from 'dotenv'

const execFileAsync = promisify(execFile)

dotenv.config({ path: path.join(__dirname, '..', '.env') })

// 延迟构造：缺 Key 时不在加载期抛错，而是让对应能力优雅降级（返回 null → 走回退链）
let _deepseekClient: OpenAI | null = null
function getDeepseekClient(): OpenAI | null {
  if (!process.env.DEEPSEEK_API_KEY) return null
  if (!_deepseekClient) {
    _deepseekClient = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com'
    })
  }
  return _deepseekClient
}

let _qwenClient: OpenAI | null = null
function getQwenClient(): OpenAI | null {
  if (!process.env.DASHSCOPE_API_KEY) return null
  if (!_qwenClient) {
    _qwenClient = new OpenAI({
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    })
  }
  return _qwenClient
}

const DEEPSEEK_MODEL = 'deepseek-v4-flash'
const QWEN_VL_MODEL = 'qwen-vl-plus'

export const name = 'dsh-ess-proposal'
export const inject = ['tools']

// ── 读取 prompt / data ────────────────────────────────────────────────
function pluginRoot(...parts: string[]) {
  return path.join(__dirname, '..', ...parts)
}

function loadText(relPath: string): string {
  return fs.readFileSync(pluginRoot(relPath), 'utf-8')
}

function loadJson(relPath: string): any {
  return JSON.parse(fs.readFileSync(pluginRoot(relPath), 'utf-8'))
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v)
  }
  return out
}

// 用户级配置目录（升级安全，不随插件包被覆盖）
function userConfigDir(...parts: string[]) {
  return path.join(os.homedir(), '.dsh', 'dsh-ess-proposal', ...parts)
}

// 电价/造价假设加载顺序（后者覆盖前者）：
//   1) 硬编码兜底  2) 插件内 data/tariff.json  3) 用户自定义覆盖
// 用户覆盖位置：DSH_ESS_TARIFF_PATH 指向的文件 > ~/.dsh/dsh-ess-proposal/tariff.json
// 覆盖为浅合并，可只写想改的字段。
const tariffDefaults = (() => {
  const hardcoded: Record<string, any> = {
    solar_cost_rm_per_kwp: 4300,
    battery_cost_rm_per_kwh: 1800,
    pv_yield_kwh_per_kwp_year: 1400,
    grid_emission_kg_per_kwh: 0.581,
    fallback_rate_rm_per_kwh: 0.55
  }

  let result = { ...hardcoded }
  try {
    result = { ...result, ...(loadJson('data/tariff.json').defaults || {}) }
  } catch {
    /* 插件内文件缺失时用硬编码兜底 */
  }

  const overridePath =
    process.env.DSH_ESS_TARIFF_PATH || userConfigDir('tariff.json')
  try {
    if (fs.existsSync(overridePath)) {
      const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf-8'))
      const overrideDefaults = parsed.defaults || parsed
      result = { ...result, ...overrideDefaults }
      console.log(`✅ 已加载自定义电价假设: ${overridePath}`)
    }
  } catch (err: any) {
    console.warn(
      `自定义电价文件读取失败，改用默认假设: ${overridePath}（${err?.message ?? err}）`
    )
  }

  return result
})()

const SOLAR_COST_RM_PER_KWP = Number(tariffDefaults.solar_cost_rm_per_kwp) || 4300
const BATTERY_COST_RM_PER_KWH = Number(tariffDefaults.battery_cost_rm_per_kwh) || 1800
const PV_YIELD_KWH_PER_KWP_YR = Number(tariffDefaults.pv_yield_kwh_per_kwp_year) || 1400
const GRID_EMISSION_KG_PER_KWH = Number(tariffDefaults.grid_emission_kg_per_kwh) || 0.581
const FALLBACK_RATE = Number(tariffDefaults.fallback_rate_rm_per_kwh) || 0.55

// ── 工具函数 ──────────────────────────────────────────────────────────
function encodeImage(imagePath: string): { base64: string; mime: string } | null {
  try {
    const absolutePath = path.resolve(imagePath)
    if (!fs.existsSync(absolutePath)) {
      console.warn(`图片不存在: ${absolutePath}`)
      return null
    }
    const buffer = fs.readFileSync(absolutePath)
    const ext = path.extname(absolutePath).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
    return { base64: buffer.toString('base64'), mime }
  } catch (err) {
    console.error(`读取图片失败: ${imagePath}`, err)
    return null
  }
}

function ocrBinaryPath(): string {
  // 开源版不内置 OCR 二进制。可通过 DSH_ESS_OCR_BIN 指向自备的 OCR 可执行文件
  //（契约：接收图片路径作为唯一参数，将识别文本输出到 stdout）。
  // 未设置且默认路径不存在时，OCR 回退会被优雅跳过（走 Qwen-VL / 正则兜底）。
  return process.env.DSH_ESS_OCR_BIN || pluginRoot('bin', 'ocr-macos')
}

async function ocrImage(imagePath: string): Promise<string> {
  const absolutePath = path.resolve(imagePath)
  if (!fs.existsSync(absolutePath)) return ''
  const bin = ocrBinaryPath()
  if (!fs.existsSync(bin)) {
    console.warn(`OCR 工具不存在: ${bin}`)
    return ''
  }
  try {
    const { stdout } = await execFileAsync(bin, [absolutePath], {
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout.trim()
  } catch (err: any) {
    console.error(`OCR 失败: ${imagePath}`, err?.message ?? err)
    return ''
  }
}

// ── 百炼 Qwen VL ──────────────────────────────────────────────────────
async function extractWithQwenVL(
  billImages: string[],
  location: string,
  customerType: string
): Promise<Record<string, any> | null> {
  const client = getQwenClient()
  if (!client) {
    console.warn('未配置 DASHSCOPE_API_KEY，跳过 Qwen VL')
    return null
  }

  let promptTemplate = ''
  try {
    promptTemplate = loadText('prompt/extract-qwen-vl.md')
  } catch {
    promptTemplate = `你是马来西亚 TNB 电费单分析助手。客户类型：{{customer_type}}，位置：{{location}}。只返回 JSON。`
  }

  const promptText = renderPrompt(promptTemplate, {
    customer_type: customerType,
    location
  })

  const content: any[] = [{ type: 'text', text: promptText }]

  let hasImage = false
  for (const imgPath of billImages) {
    const encoded = encodeImage(imgPath)
    if (encoded) {
      hasImage = true
      content.push({
        type: 'image_url',
        image_url: { url: `data:${encoded.mime};base64,${encoded.base64}` }
      })
    }
  }
  if (!hasImage) return null

  try {
    const response = await client.chat.completions.create({
      model: QWEN_VL_MODEL,
      messages: [{ role: 'user', content }],
      temperature: 0.1
    })

    const text = response.choices[0]?.message?.content || ''
    console.log('Qwen VL 返回:', text)

    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    return null
  } catch (err: any) {
    console.error('Qwen VL 调用失败:', err?.message ?? err)
    return null
  }
}

// ── DeepSeek 文本结构化 ───────────────────────────────────────────────
async function parseWithLLM(
  ocrText: string,
  location: string,
  customerType: string
): Promise<Record<string, any> | null> {
  const client = getDeepseekClient()
  if (!client) {
    console.warn('未配置 DEEPSEEK_API_KEY，跳过 DeepSeek 结构化，回退正则解析')
    return null
  }

  let promptTemplate = ''
  try {
    promptTemplate = loadText('prompt/extract-ocr-llm.md')
  } catch {
    promptTemplate = `提取电费单 JSON。客户类型：{{customer_type}}，位置：{{location}}\n\n{{ocr_text}}`
  }

  const promptText = renderPrompt(promptTemplate, {
    customer_type: customerType,
    location,
    ocr_text: ocrText
  })

  try {
    const response = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: promptText }],
      temperature: 0.1
    })

    const text = response.choices[0]?.message?.content || ''
    console.log('LLM 提取返回:', text)
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    return null
  } catch (err: any) {
    console.error('LLM 提取失败:', err?.message ?? err)
    return null
  }
}

// ── 正则回退 ──────────────────────────────────────────────────────────
function parseOcrFallback(ocrText: string): Record<string, any> {
  const kwhMatches = [...ocrText.matchAll(/(\d[\d,]*)\s*kWh/g)].map(
    (m) => parseFloat(m[1].replace(/,/g, '')) || 0
  )
  const peakKwh = kwhMatches[0] ?? 0
  const offpeakKwh = kwhMatches.length > 1 ? kwhMatches[1] : peakKwh
  const totalKwh = kwhMatches.length > 1 ? peakKwh + offpeakKwh : peakKwh

  let totalBill = 0
  const jIdx = ocrText.lastIndexOf('Jumlah')
  if (jIdx >= 0) {
    const after = ocrText.slice(jIdx)
    const vals = [...after.matchAll(/RM\s?(\d[\d,]*\.\d{2})/g)]
      .slice(0, 2)
      .map((m) => parseFloat(m[1].replace(/,/g, '')) || 0)
    totalBill = vals.reduce((a, b) => a + b, 0)
  }
  if (!totalBill) {
    const all = [...ocrText.matchAll(/RM\s?(\d[\d,]*\.\d{2})/g)].map(
      (m) => parseFloat(m[1].replace(/,/g, '')) || 0
    )
    if (all.length) totalBill = Math.max(...all)
  }

  return {
    tariff_code: null,
    peak_kwh: peakKwh,
    offpeak_kwh: offpeakKwh,
    total_kwh: totalKwh,
    max_demand_kw: 0,
    total_bill_myr: totalBill,
    notes: '使用正则回退解析（LLM 提取不可用）'
  }
}

/** 居民账单常见误读：把 266.30 读成 26630 */
function sanitizeExtractedBill(
  data: {
    tariff_code: string | null
    peak_kwh: number
    offpeak_kwh: number
    total_kwh: number
    max_demand_kw: number
    total_bill_myr: number
    raw_text: string
    extract_method: string
  },
  customerType: string
) {
  let totalBill = data.total_bill_myr
  let noteExtra = ''

  if (
    customerType === 'residential' &&
    data.total_kwh > 0 &&
    data.total_kwh < 3000 &&
    totalBill > 5000
  ) {
    const fixed = totalBill / 100
    const rate = fixed / data.total_kwh
    if (rate >= 0.05 && rate <= 2.0) {
      noteExtra = `；金额已自动校正 ${totalBill} → ${fixed}（疑似漏小数点）`
      totalBill = fixed
    }
  }

  return {
    ...data,
    total_bill_myr: totalBill,
    raw_text: (data.raw_text || '') + noteExtra
  }
}

// ── 提取主流程 ────────────────────────────────────────────────────────
export async function extractBillData(
  billImages: string[],
  location: string,
  customerType: string
) {
  if (!billImages || billImages.length === 0) {
    return {
      tariff_code: null,
      peak_kwh: 0,
      offpeak_kwh: 0,
      total_kwh: 0,
      max_demand_kw: 0,
      total_bill_myr: 0,
      raw_text: '未提供电费单图片',
      extract_method: 'none'
    }
  }

  const qwenResult = await extractWithQwenVL(billImages, location, customerType)
  if (qwenResult && (Number(qwenResult.total_kwh) > 0 || Number(qwenResult.total_bill_myr) > 0)) {
    return sanitizeExtractedBill(
      {
        tariff_code: qwenResult.tariff_code ?? null,
        peak_kwh: Number(qwenResult.peak_kwh) || 0,
        offpeak_kwh: Number(qwenResult.offpeak_kwh) || 0,
        total_kwh: Number(qwenResult.total_kwh) || 0,
        max_demand_kw: Number(qwenResult.max_demand_kw) || 0,
        total_bill_myr: Number(qwenResult.total_bill_myr) || 0,
        raw_text: qwenResult.notes || 'Qwen VL 提取',
        extract_method: 'qwen-vl'
      },
      customerType
    )
  }

  console.log('Qwen VL 未拿到有效数据，回退到本地 OCR')
  const ocrParts: string[] = []
  for (const imgPath of billImages) {
    const text = await ocrImage(imgPath)
    if (text) ocrParts.push(`【电费单: ${path.basename(imgPath)}】\n${text}`)
  }
  const ocrText = ocrParts.join('\n\n')

  if (!ocrText) {
    return {
      tariff_code: null,
      peak_kwh: 0,
      offpeak_kwh: 0,
      total_kwh: 0,
      max_demand_kw: 0,
      total_bill_myr: 0,
      raw_text: 'OCR 未提取到文本（图片无法识别或缺少 OCR 工具）',
      extract_method: 'ocr-failed'
    }
  }

  const parsed =
    (await parseWithLLM(ocrText, location, customerType)) ||
    parseOcrFallback(ocrText)

  return sanitizeExtractedBill(
    {
      tariff_code: parsed.tariff_code ?? null,
      peak_kwh: Number(parsed.peak_kwh) || 0,
      offpeak_kwh: Number(parsed.offpeak_kwh) || 0,
      total_kwh: Number(parsed.total_kwh) || 0,
      max_demand_kw: Number(parsed.max_demand_kw) || 0,
      total_bill_myr: Number(parsed.total_bill_myr) || 0,
      raw_text: ocrText,
      extract_method: parsed.notes?.includes('正则') ? 'ocr-regex' : 'ocr-llm'
    },
    customerType
  )
}

// ── 方案计算 ──────────────────────────────────────────────────────────
export function buildProposal(
  extracted: {
    total_kwh: number
    total_bill_myr: number
    max_demand_kw: number
    tariff_code: string | null
  },
  opts: {
    customerType: string
    location: string
    targetPaybackYears: number
    specialRequirements?: string
  }
) {
  const { customerType, location, targetPaybackYears } = opts
  const special = opts.specialRequirements || ''
  const wantBattery = /(电池|储能|battery|storage|ess|backup)/i.test(special)

  const annualKwh = extracted.total_kwh * 12
  const effRate =
    extracted.total_bill_myr > 0 && extracted.total_kwh > 0
      ? extracted.total_bill_myr / extracted.total_kwh
      : FALLBACK_RATE
  const dailyKwh = extracted.total_kwh > 0 ? extracted.total_kwh / 30 : 0

  const rawPv = (annualKwh * 0.75) / PV_YIELD_KWH_PER_KWP_YR
  let pvKwp = Math.max(2, Math.round(rawPv))
  if (customerType === 'datacenter') pvKwp = Math.min(pvKwp, 500)

  let storageKwh = 0
  if (wantBattery) {
    storageKwh = 10
  } else if (customerType === 'residential') {
    if (extracted.total_bill_myr >= 800)
      storageKwh = Math.max(0, Math.round((dailyKwh * 0.5) / 5) * 5)
  } else if (customerType === 'commercial' || customerType === 'factory') {
    if (extracted.total_bill_myr >= 5000)
      storageKwh = Math.max(0, Math.round((dailyKwh * 0.25) / 5) * 5)
  }
  const storageKw = storageKwh > 0 ? Math.max(3, Math.round(storageKwh / 2)) : 0

  const annualGen = pvKwp * PV_YIELD_KWH_PER_KWP_YR
  const selfRatio =
    annualGen <= annualKwh ? 0.8 : (0.8 * annualKwh) / annualGen
  const selfConsumedKwh = annualGen * selfRatio
  let annualSaving = selfConsumedKwh * effRate
  const annualBill = extracted.total_bill_myr * 12
  if (storageKwh > 0 && (customerType === 'commercial' || customerType === 'factory')) {
    annualSaving += annualBill * 0.06
  }

  const investment =
    pvKwp * SOLAR_COST_RM_PER_KWP + storageKwh * BATTERY_COST_RM_PER_KWH
  const payback = annualSaving > 0 ? investment / annualSaving : null
  const roi = annualSaving > 0 ? (annualSaving / investment) * 100 : 0
  const co2Kg = annualGen * GRID_EMISSION_KG_PER_KWH

  const notes: string[] = [
    `按年用电 ${annualKwh.toLocaleString()} kWh、有效电价 RM ${effRate.toFixed(3)}/kWh 测算`,
    `光伏年发电量约 ${annualGen.toLocaleString()} kWh（自用率 ${(selfRatio * 100).toFixed(0)}%）`,
    `安装造价假设：光伏 RM ${SOLAR_COST_RM_PER_KWP}/kWp，储能 RM ${BATTERY_COST_RM_PER_KWH}/kWh（来自 data/tariff.json）`
  ]
  if (storageKwh > 0 && customerType === 'residential') {
    notes.push('居民电价无峰谷价差，储能主要提供备用电源价值，会拉长回收期')
  }
  if (customerType === 'residential' && storageKwh === 0 && !wantBattery) {
    notes.push('本账单规模下暂不推荐配置储能（无峰谷价差、回收期不划算），可追加预算时再评估')
  }

  const risks: string[] = []
  if (payback !== null && targetPaybackYears > 0 && payback > targetPaybackYears) {
    risks.push(
      `目标 ${targetPaybackYears} 年回收在本账单规模下无法达成：当前配置回收期约 ${payback.toFixed(1)} 年。` +
        '可选路径：缩小系统规模、申请政府/银行融资降低前期投入，或接受更长回收期。'
    )
  }
  if (extracted.total_kwh === 0) {
    risks.push('未能从账单提取用电量，配置为经验默认值，请人工核实')
  }
  if (extracted.max_demand_kw > 0) {
    risks.push(`账单含需量费用（${extracted.max_demand_kw} kW），建议按需量优化储能放电策略`)
  }
  risks.push('实际发电量受屋顶朝向/遮挡影响，需现场勘察确认最终装机')

  return {
    recommended_config: {
      pv_kwp: pvKwp,
      storage_kw: storageKw,
      storage_kwh: storageKwh,
      notes
    },
    financial: {
      estimated_investment: Math.round(investment),
      annual_saving: Math.round(annualSaving),
      monthly_saving: Math.round(annualSaving / 12),
      payback_years: payback ? Number(payback.toFixed(1)) : null,
      roi: Number(roi.toFixed(1)),
      co2_reduction_kg_per_year: Math.round(co2Kg)
    },
    assumptions: {
      solar_cost_rm_per_kwp: SOLAR_COST_RM_PER_KWP,
      battery_cost_rm_per_kwh: BATTERY_COST_RM_PER_KWH,
      pv_yield_kwh_per_kwp_year: PV_YIELD_KWH_PER_KWP_YR,
      effective_tariff_rm_per_kwh: Number(effRate.toFixed(3)),
      self_consumption_ratio: Number(selfRatio.toFixed(2))
    },
    risks,
    location,
    customer_type: customerType
  }
}

// ── 插件注册 ──────────────────────────────────────────────────────────
export function apply(ctx: Context) {
  console.log('✅ dsh-ess-proposal 插件已加载')

  ctx.tools.register(
    defineTool({
      name: 'generate_ess_proposal',
      description:
        '根据客户电费单和基本信息，生成光伏+储能方案（含配置推荐和ROI测算）。支持传入电费单图片路径。',

      parameters: {
        customer_type: {
          type: 'string',
          required: true,
          description: '客户类型：residential / commercial / factory / datacenter'
        },
        location: {
          type: 'string',
          required: true,
          description: '客户所在位置，例如 Selangor, Johor, Kuala Lumpur'
        },
        target_payback_years: {
          type: 'number',
          description: '目标回收期（年），默认5'
        },
        special_requirements: {
          type: 'string',
          description: '特殊要求，可选'
        },
        bill_images: {
          type: 'array',
          items: { type: 'string' },
          description: '电费单图片本地路径列表，可选'
        },
        site_images: {
          type: 'array',
          items: { type: 'string' },
          description: '现场照片本地路径列表，可选'
        }
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: true
        },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
      },

      async execute(args, _exec) {
        const billImages = (args.bill_images as string[]) || []
        const siteImages = (args.site_images as string[]) || []
        const customerType = (args.customer_type as string) || 'residential'
        const location = (args.location as string) || ''
        const targetPayback = Number(args.target_payback_years) || 5
        const special = (args.special_requirements as string) || ''

        console.log('开始处理方案，电费单数量:', billImages.length)

        const extracted = await extractBillData(billImages, location, customerType)
        const proposal = buildProposal(extracted, {
          customerType,
          location,
          targetPaybackYears: targetPayback,
          specialRequirements: special
        })

        const missingInfo: string[] = []
        if (extracted.total_kwh === 0) {
          missingInfo.push(
            '未能从账单提取用电量（请提供清晰的电费单图片或手动补充数据）'
          )
        }
        if (siteImages.length > 0) {
          missingInfo.push(
            '现场照片已提供，但屋顶结构/朝向需人工勘察确认装机容量'
          )
        }

        return {
          summary:
            extracted.total_kwh > 0
              ? `已解析电费单：月用电 ${extracted.total_kwh} kWh、月电费 RM ${extracted.total_bill_myr.toFixed(2)}。` +
                `推荐 ${proposal.recommended_config.pv_kwp} kWp 光伏` +
                (proposal.recommended_config.storage_kwh > 0
                  ? ` + ${proposal.recommended_config.storage_kwh} kWh 储能`
                  : '（暂不配储能）') +
                `，预计投资 RM ${proposal.financial.estimated_investment.toLocaleString()}，回收期约 ${proposal.financial.payback_years ?? 'N/A'} 年。` +
                `（提取方式: ${extracted.extract_method}）`
              : '未能从电费单提取数据，返回经验默认配置，请核实。',
          extracted_data: extracted,
          recommended_config: proposal.recommended_config,
          financial: proposal.financial,
          assumptions: proposal.assumptions,
          risks: proposal.risks,
          missing_info: missingInfo,
          note: 'Prompt 来自 prompt/；造价与发电假设来自 data/tariff.json；优先 Qwen VL，失败回退 OCR + DeepSeek'
        }
      }
    })
  )
}