/** 只保留非默认选项，兼容既有纯文字作业的请求身份。 */
export function analysisInputOptions(input = {}) {
  if (input.input_format !== undefined && !['text', 'markdown'].includes(input.input_format) ||
      input.include_images !== undefined && typeof input.include_images !== 'boolean') {
    throw Object.assign(new Error('请选择 text／markdown 及有效的图片选项。'), { code: 'ANALYSIS_INVALID', status: 400 })
  }
  return { ...(input.input_format === 'markdown' ? { input_format: 'markdown' } : {}),
    ...(input.include_images === true ? { include_images: true } : {}) }
}
