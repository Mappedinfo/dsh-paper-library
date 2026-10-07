import { loadQuestionnaire } from './reading-questions.mjs'

/** 只保留非默认选项，兼容既有纯文字作业的请求身份。 */
export function analysisInputOptions(input = {}) {
  if (input.input_format !== undefined && !['text', 'markdown'].includes(input.input_format) ||
      input.include_images !== undefined && typeof input.include_images !== 'boolean') {
    throw Object.assign(new Error('请选择 text／markdown 及有效的图片选项。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  return { ...(input.input_format === 'markdown' ? { input_format: 'markdown' } : {}),
    ...(input.include_images === true ? { include_images: true } : {}) }
}

const LEGACY_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']

/** 只保留显式选项以维持旧请求身份；新作业按冻结题库检查归属和默认模式。 */
export function analysisQuestionOptions(input = {}) {
  const hasIds = input.question_ids !== undefined
  const hasMode = input.question_mode !== undefined
  const mode = input.mode ?? 'full'

  if ((hasIds || hasMode) && mode !== 'full') {
    throw Object.assign(new Error('阅读问题选项仅适用于完整分析。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  if (hasIds && !validQuestionIds(input.question_ids)) {
    throw Object.assign(new Error('请选择不重复的有效阅读问题。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  if (hasMode && !['grouped', 'separate'].includes(input.question_mode)) {
    throw Object.assign(new Error('阅读问题模式无效。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  return {
    ...(hasIds ? { question_ids: [...input.question_ids] } : {}),
    ...(hasMode ? { question_mode: input.question_mode } : {}),
  }
}

export function validQuestionIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 24 || new Set(value).size !== value.length) return false
  const current = loadQuestionnaire().questions.map(question => question.id)
  // 旧标识只允许通过入口的身份校验，供已保存请求读取；新请求随后须匹配当前题库。
  const known = new Set([...current, ...LEGACY_IDS])
  return value.length <= Math.max(current.length, LEGACY_IDS.length) && value.every(id => known.has(id))
}
