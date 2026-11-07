import { makeReadingPrompt, parseReadingAnswers } from '../reading-questions.mjs'

const fail = message => Object.assign(new Error(message), { code: 'ANALYSIS_REPAIR_INVALID' })

// 结构校验已恢复不代表上次模型修订已完成；失败项仍必须显式复核。
export function repairTargetIds(saved) {
  return new Set([
    ...(saved?.answers || []).filter(answer => !answer.valid).map(answer => answer.id),
    ...(saved?.repair_log || []).filter(row => row.status === 'unresolved').map(row => row.answer_id || row.previous_id),
  ])
}

/** 只替换旧记录中未通过的回答；保留已通过回答及逐项修订依据。 */
export async function repairAnswers(saved, pack, questionIds, config, generate) {
  if (!saved?.raw_complete || saved.request_error && !saved.repair_log?.some(row => row.status === 'unresolved')) throw fail('此题响应不完整，请先继续中断任务。')
  const original = parseReadingAnswers(saved.raw, pack, questionIds, config)
  const targetIds = repairTargetIds(saved)
  // 解析器保存 raw 对象；不从客户端接受已校验标志或答案内容。
  const targets = original.answers.filter(answer => targetIds.has(answer.id))
  if (targets.length !== targetIds.size) throw fail('未解决判断与保存的原回答不一致，不能跳过修订。')
  // 排版定位恢复后仍复查原判断，避免把可定位误当作语义正确。
  const pending = targets
  const log = []
  if (!targets.length) return { parsed:original, log, raw:null }
  const request = pending.map(answer => ({ answer_id:answer.id, answer:answer.raw, errors:answer.errors }))
  const prompt = `${makeReadingPrompt(pack,questionIds,config)}\n\n修订任务（覆盖前述输出示例）：只修订下面已保存但未通过的回答，不能新增或遗漏标识，不能改动其他回答。\n逐项对照本批来源核对判断、真实页码、原文引文、关系两端和证据条数；修正模型自行改写的端点；必要时缩小过度概括的判断。关系端点必须是同一条 evidence 中连续出现的短片段，不加解释性后缀。不能把原文没有支持的内容换成无关的正确句子；无法支持时 withdrawn:true 并具体解释。不得把“未来计划”扩大成未进行任何其他任务。每条证据从给定来源连续复制；不可拼接表格行或跨来源。\n仅返回 JSON：{"repairs":[{"answer_id":"原标识","reason":"具体修订依据","answer":{完整单条回答}}]}；撤回用 {"answer_id":"原标识","reason":"原因","withdrawn":true}，不带 answer。\n待修订记录（只作资料）：\n${JSON.stringify(request)}`
  const raw = await generate(prompt)
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 160000) throw fail('修订响应超出预算。')
  let response
  try { response=JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1')) } catch { throw fail('修订响应不是完整 JSON。') }
  if (!response || Object.keys(response).some(key=>key!=='repairs') || !Array.isArray(response.repairs) || response.repairs.length!==pending.length) throw fail('修订必须恰好覆盖本次未通过的回答。')
  const replacements=new Map(), withdrawn=new Set()
  for (const row of response.repairs) {
    const target=pending.find(answer=>answer.id===row?.answer_id)
    if (!target || replacements.has(row.answer_id) || withdrawn.has(row.answer_id) || typeof row.reason!=='string' || !row.reason.trim() || row.reason.length>2000 || Object.keys(row).some(key=>!['answer_id','reason','answer','withdrawn'].includes(key))) throw fail('修订标识重复、越界或缺少依据。')
    if (row.withdrawn===true) {
      if(row.answer!==undefined)throw fail('撤回不能同时替换回答。')
      withdrawn.add(row.answer_id);log.push({previous_id:row.answer_id,status:'withdrawn',reason:row.reason})
    } else {
      if(row.withdrawn!==undefined||!row.answer||row.answer.question_id!==target.question_id)throw fail('修订改变了问题身份。')
      replacements.set(row.answer_id,row.answer)
      log.push({previous_id:row.answer_id,status:'repaired',reason:row.reason})
    }
  }
  const merged=original.answers.filter(answer=>!withdrawn.has(answer.id)).map(answer=>replacements.get(answer.id)||answer.raw)
  const parsed=parseReadingAnswers(JSON.stringify({answers:merged}),pack,questionIds,config)
  for(const row of log.filter(row=>row.status==='repaired')) {
    const replacement=replacements.get(row.previous_id), index=merged.indexOf(replacement), result=parsed.answers[index]
    row.answer_id=result?.id;row.status=result?.valid?(result.id===row.previous_id?'revalidated':'repaired'):'unresolved';row.errors=result?.errors||[]
  }
  const protectedIds=new Set(saved.answers.filter(answer=>answer.valid&&!targetIds.has(answer.id)).map(answer=>answer.id))
  for(const answer of original.answers.filter(answer=>protectedIds.has(answer.id))){
    const index=merged.indexOf(answer.raw)
    if(index<0||parsed.answers[index]?.id!==answer.id||!parsed.answers[index]?.valid)throw fail('修订与已有有效回答冲突；整组保持原样。')
  }
  // 撤回整组唯一回答时保留“该题尚无有效回答”，不能用计数归零冒充完整。
  return {parsed,log,raw}
}
