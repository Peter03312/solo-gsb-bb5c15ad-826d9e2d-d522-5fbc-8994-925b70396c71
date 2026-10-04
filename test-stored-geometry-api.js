'use strict';

// 落盘精度修复 · 端到端 HTTP 自测（npm test）：
//   1) 合法高精度轮廓/视野：顶点保留 3 位小数落盘，响应即实际写入坐标，
//      测量值与视野统计均按落盘（取整后）坐标计算；
//   2) 取整后才非法的批次（相邻点重合/边自接触/孔洞贴边或互触）→ HTTP 400，
//      错误明确指出细胞或视野，整批不写入、草稿版本与修订数不变；
//   3) 一批中混有一个取整后非法对象：整批拒绝（合法对象也不落盘）；
//   4) 版本冲突 409 约定不变；
//   5) 修复前已落库的几何（直接改库模拟）原样读出、不被静默改写、不影响发布冻结契约。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const PORT = 8257;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-round-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  const db = new Database(path.join(DATA_DIR, 'app.db'));

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;

    // 定标：100px = 100μm → scale 1（面积 px² 即 μm²）
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body);
    const v2 = r.body.version;

    // ---------- 1) 合法高精度轮廓：取整后落盘，测量按落盘坐标 ----------
    const goodOuter = [
      { x: 10.0004, y: 10.0004 }, { x: 30.0004, y: 10.0004 },
      { x: 30.0004, y: 30.0004 }, { x: 10.0004, y: 30.0004 }
    ]; // 取整后 = (10,10)-(30,30)，20×20 → 净 400 px²
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: v2, cells: [{ id: 'c1', name: '细胞1', outer: goodOuter, holes: [] }]
    });
    check('合法高精度轮廓保存 200', r.status === 200, r.body);
    check('响应坐标为实际写入的 3 位小数坐标',
      JSON.stringify(r.body.cells[0].outer) ===
      JSON.stringify([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]),
      r.body.cells[0].outer);
    check('测量值按落盘坐标计算（400 μm² / 80 μm）',
      r.body.cells[0].areaUm2 === 400 && r.body.cells[0].perimeterUm === 80,
      r.body.cells[0]);
    const v3 = r.body.version;
    let revCount = db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId).n;
    check('成功保存追加一条修订（共 3 条）', revCount === 3, { revCount });

    // ---------- 2) 取整后相邻点重合：400，指出对象，整批不写入 ----------
    const mergedOuter = [
      { x: 50, y: 50 }, { x: 50.0004, y: 50 }, { x: 70, y: 50 },
      { x: 70, y: 70 }, { x: 50, y: 70 }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: v3, cells: [{ id: 'bad1', name: '重合点细胞', outer: mergedOuter, holes: [] }]
    });
    check('取整后相邻点重合 → 400', r.status === 400, r.body);
    check('错误指出具体细胞与取整后重复原因',
      /细胞「重合点细胞」/.test(r.body.error) && /重复/.test(r.body.error), r.body && r.body.error);

    let g = await jget(`/api/images/${imgId}`);
    check('拒绝后草稿仍是上一版（c1，1 个细胞）、版本不变',
      g.body.version === v3 && g.body.cells.length === 1 && g.body.cells[0].id === 'c1',
      { version: g.body.version, n: g.body.cells.length });
    revCount = db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId).n;
    check('拒绝后不新增修订（仍 3 条）', revCount === 3, { revCount });

    // ---------- 3) 取整后孔洞贴外环：400 ----------
    const touchingHole = [
      { x: 10.0004, y: 15 }, { x: 20, y: 15 }, { x: 20, y: 25 }, { x: 10.0004, y: 25 }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: v3,
      cells: [{
        id: 'c2', name: '孔洞贴边',
        outer: rect(10, 10, 30, 30), holes: [touchingHole]
      }]
    });
    check('取整后孔洞贴外环 → 400 并指出孔洞',
      r.status === 400 && /细胞「孔洞贴边」/.test(r.body.error) && /孔洞 1/.test(r.body.error),
      r.body);
    g = await jget(`/api/images/${imgId}`);
    check('再次拒绝后版本/细胞不变', g.body.version === v3 && g.body.cells.length === 1);

    // ---------- 4) 批次混合：一个合法 + 一个取整后自接触 → 整批拒绝 ----------
    // 外框 (100,100)-(300,300) 顶部开 U 缺口，缺口开口在 y=100.0004（与顶边留 0.0004 窄通道）：
    // 原始是合法简单多边形；取整后缺口开口贴到 y=100 顶边，非相邻边共线重叠（自接触）。
    const slitOuter = [
      { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 },
      { x: 100, y: 100.0004 }, { x: 150, y: 100.0004 }, { x: 150, y: 250 },
      { x: 200, y: 250 }, { x: 200, y: 100.0004 }, { x: 250, y: 100.0004 }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: v3,
      cells: [
        { id: 'ok', name: '合法细胞', outer: rect(80, 80, 20, 20), holes: [] },
        { id: 'slit', name: '窄缝细胞', outer: slitOuter, holes: [] }
      ]
    });
    check('混合批次 → 400 且指出非法对象',
      r.status === 400 && /细胞「窄缝细胞」/.test(r.body.error), r.body);
    g = await jget(`/api/images/${imgId}`);
    check('合法对象也未落盘（仍只有 c1）、版本不变',
      g.body.cells.length === 1 && g.body.cells[0].id === 'c1' && g.body.version === v3);

    // ---------- 5) 版本冲突约定不变（409 + currentVersion） ----------
    const stale = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: v3 - 1,
      cells: [{ id: 'x', name: 'x', outer: rect(0, 0, 10, 10), holes: [] }]
    });
    check('过期版本保存轮廓 → 409',
      stale.status === 409 && stale.body.currentVersion === v3, stale.body);

    // ---------- 6) 视野：取整后非法 → 400，整批不写入 ----------
    const badField = {
      id: 'fbad', name: '坏视野',
      outer: [
        { x: 0, y: 0 }, { x: 0.0004, y: 0 }, { x: 50, y: 0 },
        { x: 50, y: 50 }, { x: 0, y: 50 }
      ],
      holes: []
    };
    r = await jsend('PUT', `/api/images/${imgId}/fields`, { version: v3, fields: [badField] });
    check('取整后顶点重合的视野 → 400 并指出视野',
      r.status === 400 && /视野「坏视野」/.test(r.body.error) && /重复/.test(r.body.error), r.body);
    g = await jget(`/api/images/${imgId}`);
    check('视野拒绝后 fields 为空、版本不变', g.body.fields.length === 0 && g.body.version === v3);
    revCount = db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId).n;
    check('视野拒绝不新增修订（仍 3 条）', revCount === 3, { revCount });

    // 视野孔洞取整后互触 → 400
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: v3,
      fields: [{
        id: 'f2', name: '孔互触',
        outer: rect(0, 0, 200, 200),
        holes: [
          rect(20, 20, 20, 20),
          [{ x: 40.0004, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40.0004, y: 40 }]
        ]
      }]
    });
    check('视野孔洞取整后互触 → 400',
      r.status === 400 && /视野「孔互触」/.test(r.body.error) && /孔洞 1 与孔洞 2/.test(r.body.error),
      r.body);
    g = await jget(`/api/images/${imgId}`);
    check('仍无视野落盘、版本不变', g.body.fields.length === 0 && g.body.version === v3);

    // ---------- 7) 合法高精度视野：取整落盘，fieldStats 按落盘坐标 ----------
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: v3,
      fields: [{
        id: 'f1', name: '区1',
        // 取整后 (0,0)-(50,50)：净面积 2500 px² = 0.0025 mm²；c1 质心 (20,20) 被计入
        outer: [
          { x: 0.0001, y: 0 }, { x: 50.0004, y: 0 },
          { x: 50.0004, y: 50.0004 }, { x: 0.0001, y: 50.0004 }
        ],
        holes: []
      }]
    });
    check('合法高精度视野保存 200', r.status === 200, r.body);
    check('视野坐标按 3 位小数落盘',
      JSON.stringify(r.body.fields[0].outer) ===
      JSON.stringify(rect(0, 0, 50, 50)), r.body.fields[0].outer);
    const stat = r.body.fieldStats[0];
    check('视野统计按落盘几何（2500 px²=0.0025 mm²，计入 c1）',
      Math.abs(stat.areaMm2 - 0.0025) < 1e-12 &&
      stat.cellCount === 1 &&
      JSON.stringify(stat.countedCellKeys) === JSON.stringify(['c1']), stat);
    const v4 = r.body.version;
    revCount = db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId).n;
    check('视野成功保存追加一条修订（共 4 条）', revCount === 4, { revCount });

    // ---------- 8) 既有历史几何原样读出、不被静默改写 ----------
    // 直接改库塞入修复前可能存在的“取整后重合点”轮廓（模拟历史数据）
    const imgRow = db.prepare('SELECT * FROM images WHERE id = ?').get(imgId);
    const legacyCells = [{
      id: 'legacy-bad', name: '历史轮廓',
      outer: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }, { x: 1, y: 9 }],
      holes: [], areaUm2: 64, perimeterUm: 32
    }];
    db.prepare('UPDATE images SET cells = ? WHERE id = ?').run(JSON.stringify(legacyCells), imgId);
    g = await jget(`/api/images/${imgId}`);
    check('历史几何原样读出、不报错、不被静默改写',
      g.body.cells.length === 1 && g.body.cells[0].id === 'legacy-bad' &&
      g.body.cells[0].outer[0].x === 1 && g.body.cells[0].outer[1].x === 1,
      g.body && g.body.cells);

    // 历史数据仍可按原契约发布（发布只查定标/测量值，不重放新写入校验）
    const pub = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: g.body.version, title: '历史几何冻结报告'
    });
    check('含历史几何的草稿发布契约不变 → 201', pub.status === 201, pub.body);
    check('报告冻结历史几何（不重校验、不改写）',
      pub.body.report.cells.length === 1 && pub.body.report.cells[0].id === 'legacy-bad',
      pub.body.report);

  } finally {
    db.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部落盘精度修复 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
