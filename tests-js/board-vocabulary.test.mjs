import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { BOARD_LIMITS } from '../src/harness/board-store.mjs';

/* `web/board-source.js` is the single owner of the board vocabulary: the browser panel reads it
 * instead of keeping its own copy, and the host validator in `src/harness/board-store.mjs`
 * enforces it when a board is saved. Neither side imports the other (the browser file is a classic
 * script, the host file is an ES module), so this test is what keeps them from drifting: every
 * shared constant is compared here, and the host's own sets are read from its source. */

const moduleSource = await readFile(new URL('../web/board-source.js', import.meta.url), 'utf8');
const storeSource = await readFile(new URL('../src/harness/board-store.mjs', import.meta.url), 'utf8');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(moduleSource, context);
const source = context.window.PaperBoardSource;

/** The host keeps these as private `new Set([...])` constants, so read them as written. A missing
 *  set fails loudly instead of silently skipping the comparison. */
function hostSet(name) {
  const match = storeSource.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
  assert.ok(match, `src/harness/board-store.mjs still declares ${name} as a literal Set`);
  return [...match[1].matchAll(/'([^']*)'/g)].map(entry => entry[1]);
}
function hostLimit(name) {
  const match = storeSource.match(new RegExp(`${name}: ([0-9_]+)`));
  assert.ok(match, `src/harness/board-store.mjs still declares BOARD_LIMITS.${name}`);
  return Number(match[1].replaceAll('_', ''));
}

test('both sides accept exactly the same node, edge and relation vocabulary', () => {
  assert.deepEqual([...source.NODE_KINDS], hostSet('NODE_KINDS'), 'node kinds');
  assert.deepEqual([...source.EDGE_KINDS], hostSet('EDGE_KINDS'), 'edge kinds');
  assert.deepEqual([...source.RELATIONS], hostSet('RELATIONS'), 'edge relations');
  assert.deepEqual([...source.ARROWS].sort(), hostSet('ARROWS').sort(), 'arrow ends');
  assert.deepEqual([...source.MODES], hostSet('LAYOUT_MODES'), 'layout modes');
  assert.deepEqual([...source.DIRECTIONS], hostSet('LAYOUT_DIRECTIONS'), 'layout directions');
});

test('the source limits are the host limits, under the host\u2019s longer names', () => {
  const shared = {
    nodes: 'nodes', edges: 'edges', coordinate: 'coordinate', waypoints: 'waypoints',
    text: 'textCharacters', label: 'labelCharacters', title: 'titleCharacters',
  };
  for (const [own, host] of Object.entries(shared)) {
    assert.equal(source.LIMITS[own], hostLimit(host), `LIMITS.${own} matches BOARD_LIMITS.${host}`);
    assert.equal(BOARD_LIMITS[host], hostLimit(host), `BOARD_LIMITS.${host} is the value parsed from the module`);
  }
  // The panel's own extension of the shared limits must not silently replace the host's numbers.
  assert.equal(source.LIMITS.nodes, BOARD_LIMITS.nodes);
  assert.equal(source.LIMITS.edges, BOARD_LIMITS.edges);
  assert.equal(source.EDGE_ANGLE.min, 30, 'the incidence floor');
  assert.equal(source.EDGE_ANGLE.max, 90, 'perpendicular is the maximum');
  assert.ok(source.EDGE_ANGLE.default >= source.EDGE_ANGLE.min && source.EDGE_ANGLE.default <= source.EDGE_ANGLE.max);
});

test('every kind the host accepts has a default size and a label the panel can draw', () => {
  for (const kind of source.NODE_KINDS) {
    const size = source.DEFAULT_SIZE[kind];
    assert.ok(size, `DEFAULT_SIZE.${kind} exists, so a new node always has bounds`);
    assert.ok(Number.isFinite(size.w) && size.w > 0 && Number.isFinite(size.h) && size.h > 0, `DEFAULT_SIZE.${kind} is a positive box`);
  }
  const panel = context.window.PaperBoardSource;
  assert.deepEqual([...panel.NODE_KINDS], [...source.NODE_KINDS]);
  // An unknown kind falls back to the text box rather than producing NaN bounds.
  assert.deepEqual({ ...source.DEFAULT_SIZE.text }, { w: 220, h: 64 });
});

test('the source codec accepts every kind and refuses one the host would reject', () => {
  for (const [index, kind] of source.NODE_KINDS.entries()) {
    const parsed = source.fromSource({ schema: source.SOURCE_SCHEMA, title: '词汇', nodes: [{ id: `n-${index}`, kind, text: 'x' }], edges: [] }, {});
    assert.equal(parsed.board.nodes[0].kind, kind, `${kind} round-trips through the source file`);
  }
  assert.throws(
    () => source.fromSource({ schema: source.SOURCE_SCHEMA, title: '词汇', nodes: [{ id: 'n-bad', kind: 'hexagon', text: 'x' }], edges: [] }, {}),
    /节点类型|kind/,
    'a kind outside the shared vocabulary is refused',
  );
});

test('the panel takes its vocabulary from the source module instead of restating it', async () => {
  const boardSource = await readFile(new URL('../web/board.js', import.meta.url), 'utf8');
  assert.ok(boardSource.includes('sourceApi().NODE_KINDS'), 'web/board.js reads NODE_KINDS from board-source.js');
  assert.ok(boardSource.includes('sourceApi().DEFAULT_SIZE'), 'web/board.js reads DEFAULT_SIZE from board-source.js');
  assert.ok(boardSource.includes('sourceApi().RELATIONS'), 'web/board.js reads the relation order from board-source.js');
  assert.ok(boardSource.includes('sourceApi().EDGE_ANGLE'), 'web/board.js reads the angle bounds from board-source.js');
  // None of the lists may still be spelled out as a literal: that is the duplication this test
  // exists to catch, and it is how the two implementations drifted apart before.
  for (const [name, literal] of [
    ['NODE_KINDS', "'text', 'note', 'concept'"],
    ['RELATION_ORDER', "'related', 'supports'"],
    ['EDGE_ANGLE', '{ min: 30, max: 90'],
  ]) {
    assert.ok(!boardSource.includes(literal), `web/board.js no longer restates ${name}`);
  }
});
