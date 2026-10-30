/** Optional presentation hints have no meaning unless explicitly supplied. */
export const prefersStraight = edge => edge?.layout?.preferStraight === true;
export const mayOptimizePosition = node => node?.layout?.optimizePosition === true;
export const hoverKey = edge => typeof edge?.hover_key === 'string' && edge.hover_key.trim() ? edge.hover_key : null;

/** Paths are relative to logical; prevent prototype traversal and self-reference. */
export function validCompareField(path) {
  return typeof path === 'string' && path.split('.').every(segment =>
    segment.length > 0 && !/[\s.\[\]]/u.test(segment) &&
    !['__proto__', 'prototype', 'constructor', 'compare_fields'].includes(segment));
}
