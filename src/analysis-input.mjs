/** 只保留非默认选项，兼容既有纯文字作业的请求身份。 */
export function analysisInputOptions(input = {}) {
  if (input.input_format !== undefined && !['text', 'markdown'].includes(input.input_format) ||
      input.include_images !== undefined && typeof input.include_images !== 'boolean') {
    throw Object.assign(new Error('请选择 text／markdown 及有效的图片选项。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  return { ...(input.input_format === 'markdown' ? { input_format: 'markdown' } : {}),
    ...(input.include_images === true ? { include_images: true } : {}) }
}

const QUESTION_IDS = new Set(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'])

/** Preserve only explicitly supplied question controls; grouped is the runtime default. */
export function analysisQuestionOptions(input = {}) {
  const hasIds = input.question_ids !== undefined
  const hasMode = input.question_mode !== undefined
  const mode = input.mode ?? 'full'

  if ((hasIds || hasMode) && mode !== 'full') {
    throw Object.assign(new Error('阅读问题选项仅适用于完整分析。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  if (hasIds && (!Array.isArray(input.question_ids) || input.question_ids.length < 1 ||
      input.question_ids.length > QUESTION_IDS.size || new Set(input.question_ids).size !== input.question_ids.length ||
      input.question_ids.some(id => !QUESTION_IDS.has(id)))) {
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
  return Array.isArray(value) && value.length > 0 && value.length <= QUESTION_IDS.size &&
    new Set(value).size === value.length && value.every(id => QUESTION_IDS.has(id))
}
