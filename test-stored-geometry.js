'use strict';

// 落盘精度校验自测（node test-stored-geometry.js）：
// 细胞轮廓与取样视野保存时必须以【实际写入的坐标】为准——先把顶点保留 3 位小数，
// 再对取整后的环套用全部既有规则。下列用例覆盖：取整后相邻点重合、边自交/自接触、
// 孔洞贴外环、孔洞互触、净面积退化（视野）；合法高精度图形取整后通过，且测量/统计
// 与直接按取整坐标计算一致。
const assert = require('assert');
const geo = require('./server/geometry');
const fsvc = require('./server/fields');

const W = 100, H = 100;
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

// ---------- 细胞：取整后非法必须拒绝（原始顶点其实合法） ----------

// 1. 相邻点取整后重合：(1,1) 与 (1.0004,1) 原样不同、保留 3 位后相同
{
  const outer = [{ x: 1, y: 1 }, { x: 1.0004, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 10 }, { x: 1, y: 10 }];
  // 原始顶点先经旧规则：不重合、不自交 → 通过（复现漏洞来源）
  assert.doesNotThrow(() => geo.validateCell({ _seq: 1, outer }, W, H));
  // 落盘校验：必须按写入坐标拒绝并指出对象
  assert.throws(() => geo.validateStoredCell({ _seq: 1, outer }, W, H),
    (e) => /第 1 个细胞/.test(e.message) && /重复|3 位小数/.test(e.message));
  console.log('ok 1 取整后相邻顶点重合的细胞被拒绝并指出对象');
}

// 2. 非相邻边取整后自接触：从顶边伸入的窄缝深到距底边仅 0.0004，取整后缝底贴住底边
{
  const outer = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 10 },
    { x: 5, y: 0.0004 }, { x: 4, y: 0.0004 }, { x: 4, y: 9 }, { x: 0, y: 9 }
  ];
  assert.doesNotThrow(() => geo.validateCell({ _seq: 1, outer }, W, H)); // 原始缝底留有间隙
  assert.throws(() => geo.validateStoredCell({ name: '窄回折', outer }, W, H),
    (e) => /细胞「窄回折」/.test(e.message) && /自交|接触|3 位小数/.test(e.message));
  console.log('ok 2 取整后非相邻边自接触的细胞被拒绝并指出对象');
}

// 3. 孔洞取整后贴住外环（原始间隙 0.0004）
{
  const outer = rect(10, 10, 80, 80);
  const hole = [{ x: 10.0004, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }, { x: 10.0004, y: 40 }];
  assert.doesNotThrow(() => geo.validateCell({ _seq: 1, outer, holes: [hole] }, W, H));
  assert.throws(() => geo.validateStoredCell({ _seq: 1, outer, holes: [hole] }, W, H),
    (e) => /孔洞 1/.test(e.message) && /严格位于|3 位小数/.test(e.message));
  console.log('ok 3 取整后孔洞贴外环被拒绝');
}

// 4. 两个孔洞取整后互触（原始共边间隙 0.0004）
{
  const outer = rect(0, 0, 100, 100);
  const h1 = rect(10, 10, 20, 20);
  const h2 = [{ x: 30.0004, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 30.0004, y: 30 }];
  assert.doesNotThrow(() => geo.validateCell({ _seq: 1, outer, holes: [h1, h2] }, W, H));
  assert.throws(() => geo.validateStoredCell({ _seq: 1, outer, holes: [h1, h2] }, W, H),
    (e) => /孔洞 1 与孔洞 2/.test(e.message));
  console.log('ok 4 取整后孔洞互触被拒绝');
}

// 5. 非有限数顶点仍在取整前被拦下（错误位置按原始序号）
{
  assert.throws(() => geo.validateStoredCell(
    { _seq: 2, outer: [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: 10 }] }, W, H),
    /第 2 个顶点/);
  assert.throws(() => geo.validateStoredCell(
    { _seq: 1, outer: rect(0, 0, 10, 10), holes: [[]] }, W, H),
    /孔洞 1：至少需要 3 个顶点/);
  console.log('ok 5 非有限数顶点与顶点不足仍被拒绝');
}

// ---------- 视野：同样以写入坐标校验 ----------

// 6. 相邻点取整后重合的视野被拒绝并指出视野
{
  const outer = [{ x: 0, y: 0 }, { x: 0.0004, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.throws(() => geo.validateStoredField({ name: '区A', outer, holes: [] }, W, H, 3),
    (e) => /视野「区A」/.test(e.message) && /重复|3 位小数/.test(e.message));
  console.log('ok 6 取整后顶点重合的视野被拒绝并指出对象');
}

// 7. 视野孔洞取整后互触被拒绝
{
  const outer = rect(0, 0, 100, 100);
  const h1 = rect(10, 10, 20, 20);
  const h2 = [{ x: 30.0004, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 30.0004, y: 30 }];
  assert.throws(() => geo.validateStoredField({ outer, holes: [h1, h2] }, W, H, 1),
    /孔洞 1 与孔洞 2/);
  console.log('ok 7 视野孔洞取整后互触被拒绝');
}

// ---------- 合法高精度图形：取整保存，测量/统计按落盘坐标 ----------

// 8. 合法高精度矩形通过并返回 3 位小数坐标
{
  const outer = [
    { x: 10.12349, y: 10.0004 }, { x: 30.4564, y: 10.0004 },
    { x: 30.4564, y: 30.0004 }, { x: 10.12349, y: 30.0004 }
  ];
  const r = geo.validateStoredCell({ id: 'c', _seq: 1, outer, holes: [] }, W, H);
  assert.deepStrictEqual(r.outer, [
    { x: 10.123, y: 10 }, { x: 30.456, y: 10 }, { x: 30.456, y: 30 }, { x: 10.123, y: 30 }
  ]);
  // 测量值 = 对落盘环直接测量（宽 20.333、高 20）
  const m = geo.measureCell(r.outer, r.holes, 2);
  const expectedPx = 20.333 * 20;
  assert.ok(Math.abs(m.areaUm2 - expectedPx * 4) < 1e-9, `${m.areaUm2}`);
  console.log('ok 8 合法高精度细胞取整保存，测量按落盘坐标');
}

// 9. 视野统计按取整后的落盘坐标计算
{
  const fields = [{
    id: 'f', name: '区',
    outer: [{ x: 0.0001, y: 0 }, { x: 50.0004, y: 0 }, { x: 50.0004, y: 50.0004 }, { x: 0.0001, y: 50.0004 }],
    holes: []
  }];
  const vf = geo.validateStoredField(fields[0], W, H, 1);
  const savedField = { id: 'f', name: '区', outer: vf.outer, holes: vf.holes };
  const cells = [{ id: 'A', name: 'A', outer: rect(10, 10, 10, 10), holes: [] }]; // 质心 (15,15)
  const stats = fsvc.buildFieldStats([savedField], cells, 1)[0];
  // 落盘外环为 (0,0)-(50,50)：净面积 2500 px² = 0.0025 mm²，计入 A
  assert.strictEqual(stats.cellCount, 1);
  assert.ok(Math.abs(stats.areaMm2 - 0.0025) < 1e-12, `${stats.areaMm2}`);
  assert.deepStrictEqual(stats.countedCellKeys, ['A']);
  console.log('ok 9 视野统计以落盘（取整后）几何为准');
}

// 10. 合法孔洞（取整后仍留有间隙）通过
{
  const outer = rect(0, 0, 100, 100);
  const h1 = rect(10, 10, 20, 20);
  const h2 = [{ x: 30.001, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 30.001, y: 30 }];
  assert.doesNotThrow(() => geo.validateStoredCell({ _seq: 1, outer, holes: [h1, h2] }, W, H));
  assert.doesNotThrow(() => geo.validateStoredField({ outer, holes: [h1, h2] }, W, H, 1));
  console.log('ok 10 取整后仍有 0.001 间隙的孔洞合法');
}

console.log('\n全部落盘精度几何校验自测通过 ✔');
