export const paperTabKind = 'paper-library-paper'
export const paperTabPrefix = 'dsh-resource://paper-library/paper/'

export function paperTabAddress(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('文献标识无效')
  return paperTabPrefix + id
}

export function paperTabId(address) {
  if (typeof address !== 'string' || !address.startsWith(paperTabPrefix)) return null
  const id = address.slice(paperTabPrefix.length)
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null
}
