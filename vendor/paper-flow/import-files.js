import { FLOW_LIMITS } from "./budget.js";

/** Chooser and drag/drop share one file gate before reading any contents. */
export function selectFlowImportFile(files) {
  const selected = Array.from(files || []);
  if (selected.length !== 1) throw Error(selected.length ? "一次只能导入一个 JSON 文件。" : "请拖入一个 JSON 文件；不支持链接或文字。");
  const file = selected[0];
  if (!file || typeof file.text !== "function") throw Error("无法读取所选文件，请选择 JSON 文件。");
  if (file.name && !/\.json$/i.test(file.name)) throw Error("仅支持 .json 文件，请先导出论文或流程工作区 JSON。");
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > FLOW_LIMITS.workspaceBytes) throw Error("工作区超过 192 KiB 上限。");
  return file;
}

export function isFlowFileDrag(transfer) {
  return !!transfer && (Array.from(transfer.types || []).includes("Files") || transfer.files?.length > 0);
}
