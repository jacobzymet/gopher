// NODE_PATH can point to an installed Playwright package; no app build is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const source = readFileSync(join(root, 'src/ui/chat/scripts/render.js'), 'utf8');
function declaration(name) {
  return source.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\r?\\n\\}'))[0];
}
const tableHtml = '<div class="md-table-wrap"><table class="md-table">' +
  '<thead><tr><th>Season</th><th>Harvey</th><th align="right">Louis</th></tr></thead>' +
  '<tbody><tr><td>S1</td><td>Senior partner (youngest ever)</td><td>Junior partner</td></tr>' +
  '<tr><td>S8</td><td>Senior partner</td><td>Managing partner (Harvey steps down)</td></tr></tbody>' +
  '</table></div>';
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Report missing browser coverage. */ }
const browserOptions = { skip: !chromium && 'Playwright is required for table resize tests' };

async function withTable(run) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TABLE_RESIZE_BROWSER_CHANNEL ? { channel: process.env.TABLE_RESIZE_BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="msg msg-role-assistant" style="width:570px;margin:20px">' +
      '<div class="msg-bubble">' + tableHtml + '</div></div>');
    for (const stylesheet of ['base.css', 'conversation.css']) {
      await page.addStyleTag({ path: join(root, 'src/ui/chat/styles', stylesheet) });
    }
    await page.addScriptTag({ content: [
      declaration('enhanceMarkdownTables'), declaration('enhanceCiteFavicons'), declaration('enhanceCodeBlocks'),
      'enhanceCodeBlocks(document.querySelector(".msg-bubble"));',
    ].join('\n') });
    await run(page);
  } finally {
    await browser.close();
  }
}

const widths = (page) => page.locator('thead th').evaluateAll((cells) =>
  cells.map((cell) => cell.getBoundingClientRect().width));
async function dragColumn(page, index, distance) {
  const box = await page.locator('.md-column-resize').nth(index).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + distance, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

test('dragging a column changes only that column and leaves table content and alignment intact', browserOptions, async () => {
  await withTable(async (page) => {
    assert.equal(await page.getByRole('separator').count(), 3);
    const before = await widths(page);
    const content = await page.locator('table').textContent();
    await dragColumn(page, 0, 80);
    const after = await widths(page);
    assert.ok(Math.abs(after[0] - before[0] - 80) < 1);
    assert.ok(Math.abs(after[1] - before[1]) < 1);
    assert.ok(Math.abs(after[2] - before[2]) < 1);
    assert.equal(await page.locator('table').textContent(), content);
    assert.equal(await page.locator('thead th').nth(2).evaluate((cell) => getComputedStyle(cell).textAlign), 'right');
    await page.evaluate(() => enhanceCodeBlocks(document.querySelector('.msg-bubble')));
    assert.equal(await page.getByRole('separator').count(), 3);
    assert.equal(await page.locator('colgroup').count(), 1);
  });
});

test('keyboard resizing, double-click reset, and widths survive a streaming DOM replacement', browserOptions, async () => {
  await withTable(async (page) => {
    const before = await widths(page);
    const handle = page.getByRole('separator', { name: 'Resize Harvey column' });
    await handle.focus();
    await handle.press('ArrowRight');
    await handle.press('Shift+ArrowRight');
    let after = await widths(page);
    assert.ok(Math.abs(after[1] - before[1] - 64) < 1);
    assert.equal(await handle.getAttribute('aria-valuenow'), String(Math.round(after[1])));
    await handle.dblclick();
    after = await widths(page);
    assert.ok(Math.abs(after[1] - before[1]) < 1);
    await dragColumn(page, 2, 95);
    const chosen = await widths(page);
    await page.evaluate((html) => {
      const bubble = document.querySelector('.msg-bubble');
      bubble.innerHTML = html;
      enhanceCodeBlocks(bubble);
    }, tableHtml);
    const restored = await widths(page);
    restored.forEach((width, index) => assert.ok(Math.abs(width - chosen[index]) < 1));
    assert.equal(await page.getByRole('separator').count(), 3);
  });
});

test('minimum widths, cancelled drags, and wide-table scrolling work without clipping content', browserOptions, async () => {
  await withTable(async (page) => {
    await dragColumn(page, 0, -300);
    assert.ok(Math.abs((await widths(page))[0] - 48) < 1);
    const before = await widths(page);
    const box = await page.locator('.md-column-resize').nth(1).boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 105, box.y + 5);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const cancelled = await widths(page);
    cancelled.forEach((width, index) => assert.ok(Math.abs(width - before[index]) < 1));
    assert.equal(await page.locator('.is-resizing-column').count(), 0);
    await dragColumn(page, 2, 700);
    assert.equal(await page.locator('.md-table-wrap').evaluate((wrap) => wrap.scrollWidth > wrap.clientWidth), true);
    assert.equal(await page.locator('tbody td').nth(0).evaluate((cell) => getComputedStyle(cell).overflowWrap), 'anywhere');
    assert.equal(await page.locator('table').evaluate((table) => getComputedStyle(table).tableLayout), 'fixed');
  });
});

test('a narrow column with a blank heading resets to its original width', browserOptions, async () => {
  await withTable(async (page) => {
    await page.evaluate((html) => {
      const bubble = document.querySelector('.msg-bubble');
      bubble.innerHTML = html;
      enhanceCodeBlocks(bubble);
    }, tableHtml.replace('<th>Season</th>', '<th></th>'));
    const before = (await widths(page))[0];
    assert.ok(before < 48);
    await dragColumn(page, 0, 80);
    await page.getByRole('separator', { name: 'Resize Column 1 column' }).dblclick();
    assert.ok(Math.abs((await widths(page))[0] - before) < 1);
  });
});
