import { downloadZip } from 'client-zip';

export async function exportArchive(store) {
  let count = 0, size = 0;
  async function* files() {
    for await (const { path, blob } of store.exportFiles()) {
      if ((size += blob.size) > 256 * 1024 * 1024) throw new Error('ZIP 导出上限为 256 MiB。较大的库可用「迁移到文件夹」。');
      count++;
      yield { name: path, input: blob };
    }
  }
  const archive = await downloadZip(files()).blob();
  if (!count) throw new Error('库中还没有可导出的文件。');
  const url = URL.createObjectURL(archive);
  const link = document.createElement('a');
  link.href = url; link.download = 'Paper-Library.zip';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
