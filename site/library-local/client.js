// Pages itself never loads this module. All library traffic uses this tab's local origin.
export async function api(path, options) {
  const response = await fetch(path, { ...options, cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '本机请求未完成。'), { status: response.status });
  return result;
}
