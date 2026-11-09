/** 将有界 PDF 渲染结果提交为宿主原生图像附件，而不是把 base64 当文字发送。 */
const fail = (message, code) => Object.assign(new Error(message), { code })

export const paperVisualOutput = {
  schema: { type: 'json' },
  render: (_args, value) => {
    const { image, ...source } = value
    return [{ type: 'text', text: JSON.stringify(source) }, { type: 'image', attachment: image }]
  },
}

export async function readPaperVisual(ctx, exec, request, dispatch, options) {
  // 与宿主 read_image 一致，以当前请求路由为准；未声明视觉能力时不渲染、不假装看过。
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get?.('llm'), attachments = ctx.get?.('attachments')
  if (!provider || !model || !llm?.resolveModelInfo) throw fail('无法确认当前论文对话模型，请选定支持图像的模型后重试。', 'PAPER_IMAGE_ROUTE_REQUIRED')
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (!info?.inputModalities?.includes('image')) throw fail('当前论文对话模型未声明图像输入能力。请切换视觉模型；不能仅凭提取文字判断图表内容。', 'PAPER_IMAGE_MODEL_UNSUPPORTED')
  if (!attachments?.saveImage || !attachments.imageLimits?.mediaTypes?.includes('image/png')) throw fail('当前 DSH 缺少可用的 PNG 图像附件服务，请更新或启用宿主附件服务。', 'PAPER_IMAGE_SERVICE_REQUIRED')
  exec.signal.throwIfAborted()
  const value = await dispatch(request, { ...options, signal: exec.signal })
  exec.signal.throwIfAborted()
  if (value?.paper_id !== request.id || value?.page !== request.page || value?.mime_type !== 'image/png'
      || typeof value.image !== 'string' || value.image.length > 2_796_204
      || !Number.isInteger(value.width) || !Number.isInteger(value.height)
      || Math.min(value.width, value.height) < 1 || Math.max(value.width, value.height) > 2048) {
    throw fail('PDF 页面图像不完整，请重试该页。', 'PAPER_IMAGE_INVALID')
  }
  const data = Buffer.from(value.image, 'base64')
  const cap = Math.min(2 * 1024 * 1024, attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  if (!Number.isFinite(cap) || data.length > cap || data.length < 45 || data.toString('base64') !== value.image
      || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw fail('PDF 页面图像超过宿主预算或格式无效；请缩小区域后重试。', 'PAPER_IMAGE_INVALID')
  }
  const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: `paper-page-${value.page}.png` })
  exec.signal.throwIfAborted()
  const { image, mime_type, ...source } = value
  return { ...source, image: ref, notice: (source.notice || '') + ' Image is rendered PDF source, not AI description. Region coordinates use the displayed page, normalized to 0–1. Use library_paper_view with a smaller region if fine details are unreadable.' }
}
