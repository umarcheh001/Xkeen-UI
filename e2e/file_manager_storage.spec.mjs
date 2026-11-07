import { test, expect, selectPanelView } from './fixtures.mjs';

const disk = {
  id: 'Media0', product: 'USB DISK 3.0', manufacturer: '', serial: 'serial-1',
  size: 31042043904, state: 'active', port: '1', version: '3.20',
  ejectable: true, protected: true,
  partitions: [
    { media_id: 'Media0', partition_id: 'Partition3', uuid: 'opkg-uuid', label: 'OPKG',
      fstype: 'ext4', state: 'mounted', mountpoint: '/tmp/mnt/opkg-uuid',
      total: 5000000000, free: 4000000000, used_by: ['opkg'], protected: true,
      format_types: ['ext4', 'exfat'], labelable_format_types: ['ext4'],
      check_supported: true, label_tool: 'tune2fs', label_available: true },
    { media_id: 'Media0', partition_id: 'Partition4', uuid: 'test-uuid', label: 'KEEN2',
      fstype: 'ext4', state: 'mounted', mountpoint: '/tmp/mnt/test-uuid',
      total: 5000000000, free: 4900000000, used_by: ['cifs'], protected: false,
      format_types: ['ext4', 'exfat'], labelable_format_types: ['ext4'],
      check_supported: true, label_tool: 'tune2fs', label_available: true },
  ],
};

async function prepare(page, requests, availableDisks = [disk]) {
  const inventory = structuredClone(availableDisks);
  let formatSequence = 0;
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, storageUsb: { enabled: true, supported: true } } });
  });
  await page.route('**/api/storage/usb', async (route) => {
    await route.fulfill({ json: { ok: true, disks: inventory,
      items: inventory.flatMap((item) => item.partitions), ts: 1 } });
  });
  await page.route('**/api/storage/usb/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    requests.push({ path, body });
    const operation = path.split('/').at(-1);
    const targetDisk = inventory.find((item) => item.id === body.media_id);
    const part = targetDisk?.partitions.find((item) => item.partition_id === body.partition_id);
    let createdIds = [];
    const newPart = (id, start, end) => ({
      media_id: targetDisk.id, partition_id: id, uuid: '', label: '', fstype: '',
      state: 'unmounted', used_by: [], protected: false, empty: false,
      start_sector: start, end_sector: end,
      format_types: ['ext4', 'exfat'], labelable_format_types: ['ext4'],
    });
    if (operation === 'repartition') {
      targetDisk.partitions = body.sizes_mib.map((_, index) => ({
        media_id: targetDisk.id, partition_id: `Partition${index + 1}`, uuid: '', label: '',
        fstype: '', state: 'unmounted', used_by: [], protected: false,
        format_types: ['ext4', 'exfat'], labelable_format_types: ['ext4'],
      }));
    } else if (operation === 'add') {
      const number = Math.max(0, ...targetDisk.partitions.map((item) => Number(item.partition_id.replace('Partition', '')))) + 1;
      const id = `Partition${number}`;
      targetDisk.partitions.push(newPart(id, body.start_sector, body.start_sector + body.size_mib * 2048 - 1));
      targetDisk.free_ranges = [];
      createdIds = [id];
    } else if (operation === 'delete') {
      targetDisk.partitions = targetDisk.partitions.filter((item) => item !== part);
    } else if (operation === 'split') {
      const id = `Partition${Math.max(...targetDisk.partitions.map((item) => Number(item.partition_id.replace('Partition', '')))) + 1}`;
      const boundary = part.start_sector + body.size_mib * 2048;
      targetDisk.partitions = targetDisk.partitions.filter((item) => item !== part);
      targetDisk.partitions.push(newPart(part.partition_id, part.start_sector, boundary - 1), newPart(id, boundary, part.end_sector));
      createdIds = [part.partition_id, id];
    } else if (operation === 'merge') {
      const other = targetDisk.partitions.find((item) => item.partition_id === body.other_id);
      targetDisk.partitions = targetDisk.partitions.filter((item) => item !== part && item !== other);
      targetDisk.partitions.push(newPart(part.partition_id, Math.min(part.start_sector, other.start_sector),
        Math.max(part.end_sector, other.end_sector)));
      createdIds = [part.partition_id];
    } else if (operation === 'format') {
      const wasMounted = part.state === 'mounted';
      part.uuid = `formatted-${++formatSequence}`;
      part.fstype = body.fstype;
      part.label = '';
      part.state = wasMounted ? 'mounted' : 'unmounted';
    } else if (operation === 'unmount') {
      part.state = 'unmounted';
    } else if (operation === 'mount') {
      part.state = 'mounted';
    } else if (operation === 'label') {
      part.label = body.label;
    }
    await route.fulfill({ json: { ok: true, created_partition_ids: createdIds, status: [{ status: 'message' }] } });
  });
  await page.goto('/');
  await selectPanelView(page, 'files');
  await page.locator('#fm-volumes-btn').click();
  await expect(page.locator('#fm-volumes-modal')).toBeVisible();
  return inventory;
}

test('USB manager shows disks and protects OPKG while formatting another partition', async ({ page }) => {
  const requests = [];
  await page.setViewportSize({ width: 2560, height: 1360 });
  await prepare(page, requests);
  if (process.env.XKEEN_STORAGE_VISUAL) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const wide = await page.locator('#fm-volumes-modal .modal-content').evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    top: element.getBoundingClientRect().top,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  expect(wide.width).toBeGreaterThanOrEqual(1240);
  expect(wide.height).toBeGreaterThanOrEqual(940);
  expect(wide.top).toBeLessThanOrEqual(65);
  expect(wide.left).toBeGreaterThan(600);
  if (process.env.XKEEN_STORAGE_VISUAL) await page.screenshot({ path: '.tmp/storage-usb/overview-wide.png' });
  await expect(page.locator('.fm-volume-disk-head')).toContainText('USB DISK 3.0');
  const opkg = page.locator('.fm-volumes-table tr').filter({ hasText: 'OPKG' });
  await expect(opkg.getByRole('button', { name: 'Форматировать' })).toBeDisabled();
  await expect(opkg.getByRole('button', { name: 'Отключить' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Безопасно извлечь' })).toBeDisabled();
  await expect(opkg.getByRole('button', { name: 'Форматировать' }).locator('svg')).toBeVisible();

  const testPart = page.locator('.fm-volumes-table tr').filter({ hasText: 'KEEN2' });
  await testPart.getByRole('button', { name: 'Форматировать' }).click();
  const form = page.locator('#fm-volume-form');
  if (process.env.XKEEN_STORAGE_VISUAL) await page.screenshot({ path: '.tmp/storage-usb/format.png' });
  await form.getByLabel('Метка тома').fill('CUSTOM');
  await form.getByLabel(/Для подтверждения/).fill('KEEN2');
  await form.getByRole('button', { name: 'Форматировать' }).click();
  await expect(page.locator('#fm-volumes-progress')).toBeVisible();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[0]).toEqual({
    path: '/api/storage/usb/format',
    body: { media_id: 'Media0', partition_id: 'Partition4', uuid: 'test-uuid',
      fstype: 'ext4', confirm: 'FORMAT Media0/Partition4' },
  });
  expect(requests.slice(1).map((item) => item.path)).toEqual([
    '/api/storage/usb/unmount', '/api/storage/usb/label', '/api/storage/usb/mount',
  ]);
  expect(requests[2].body.label).toBe('CUSTOM');
  await expect(page.locator('#fm-volumes-progress')).toBeHidden();
});

test('USB manager remains usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await prepare(page, []);
  await expect(page.locator('.fm-volume-disk-head')).toBeVisible();
  await expect(page.locator('.fm-volume-table-wrap')).toBeVisible();
  await expect(page.locator('#fm-volumes-refresh-btn')).toBeVisible();
});

test('USB manager submits a confirmed layout for the selected disk', async ({ page }) => {
  const requests = [];
  const spare = { ...disk, id: 'Media1', product: 'Storage Media', serial: 'spare-serial',
    size: 16231956480, protected: false, partitionable: true,
    partitions: [{ ...disk.partitions[1], media_id: 'Media1', partition_id: 'Partition1',
      uuid: 'spare-uuid', label: 'DATA', used_by: [], mountpoint: '/tmp/mnt/spare-uuid' }] };
  await page.setViewportSize({ width: 1440, height: 960 });
  await prepare(page, requests, [disk, spare]);
  if (process.env.XKEEN_STORAGE_VISUAL) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  if (process.env.XKEEN_STORAGE_VISUAL) await page.screenshot({ path: '.tmp/storage-usb/overview.png' });
  const spareSection = page.locator('.fm-volume-disk').filter({ hasText: 'Storage Media' });
  await spareSection.getByRole('button', { name: 'Разметить' }).click();
  const form = page.locator('#fm-volume-form');
  await expect(page.locator('#fm-volumes-list')).toBeHidden();
  await form.locator('.fm-layout-count').getByRole('button', { name: '3' }).click();
  await expect(form.locator('input[name="size_gib"]')).toHaveCount(2);
  expect(await form.locator('.fm-layout-segment').allTextContents()).toEqual(['1', '2', '3']);
  await expect(form.locator('.fm-layout-count').getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true');
  const before = await form.locator('[data-partition-size="2"]').textContent();
  await form.locator('input[type="range"]').first().focus();
  await form.locator('input[type="range"]').first().press('ArrowRight');
  await expect(form.locator('[data-partition-size="2"]')).not.toHaveText(before);
  await form.locator('input[name="size_gib"]').first().fill('2');
  await form.locator('input[name="size_gib"]').last().fill('4');
  await form.getByLabel('Метка раздела 1').fill('SYSTEM');
  await form.getByLabel('Метка раздела 2').fill('MEDIA');
  await form.getByLabel('Метка раздела 3').fill('BACKUP');
  await form.getByLabel(/Для подтверждения/).fill('Media1');
  if (process.env.XKEEN_STORAGE_VISUAL) await page.screenshot({ path: '.tmp/storage-usb/layout.png' });
  await form.getByRole('button', { name: 'Создать разделы' }).click();
  await expect(page.locator('#fm-volumes-progress')).toBeVisible();
  await expect.poll(() => requests.length, { timeout: 30000 }).toBe(7);
  expect(requests[0]).toEqual({ path: '/api/storage/usb/repartition', body: {
    media_id: 'Media1', serial: 'spare-serial',
    expected_parts: [{ partition_id: 'Partition1', uuid: 'spare-uuid' }],
    sizes_mib: [2048, 4096, 0], confirm: 'REPARTITION Media1/spare-serial',
  } });
  expect(requests.slice(1).map((item) => item.path)).toEqual([
    '/api/storage/usb/format', '/api/storage/usb/label',
    '/api/storage/usb/format', '/api/storage/usb/label',
    '/api/storage/usb/format', '/api/storage/usb/label',
  ]);
  expect(requests.filter((item) => item.path.endsWith('/label')).map((item) => item.body.label))
    .toEqual(['SYSTEM', 'MEDIA', 'BACKUP']);
  await expect(page.locator('#fm-volumes-progress')).toBeHidden();
});

test('partition editor fits a phone viewport', async ({ page }) => {
  const spare = { ...disk, id: 'Media1', product: 'Storage Media', serial: 'spare-serial',
    size: 16231956480, protected: false, partitionable: true,
    partitions: [{ ...disk.partitions[1], media_id: 'Media1', partition_id: 'Partition1',
      uuid: 'spare-uuid', label: 'DATA', used_by: [] }] };
  await page.setViewportSize({ width: 390, height: 800 });
  await prepare(page, [], [spare]);
  if (process.env.XKEEN_STORAGE_VISUAL) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.getByRole('button', { name: 'Разметить' }).click();
  await expect(page.locator('#fm-volume-form .fm-layout-bar')).toBeVisible();
  const bounds = await page.locator('#fm-volumes-modal .modal-content').evaluate((element) => ({
    left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
  }));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  if (process.env.XKEEN_STORAGE_VISUAL) await page.screenshot({ path: '.tmp/storage-usb/layout-mobile.png' });
  await page.getByRole('button', { name: 'Назад к накопителям' }).click();
  await expect(page.locator('#fm-volumes-list')).toBeVisible();
});

test('one partition and local add, delete, split and merge workflows', async ({ page }) => {
  const requests = [];
  const spare = { ...disk, id: 'Media1', product: 'Storage Media', serial: 'spare-serial',
    size: 4294967296, protected: false, partitionable: true, sector_size: 512,
    free_ranges: [{ start_sector: 4196352, end_sector: 8388607, size_bytes: 2146435072 }],
    partitions: [{ ...disk.partitions[1], media_id: 'Media1', partition_id: 'Partition1',
      uuid: 'spare-uuid', label: 'LAB', used_by: [], empty: true,
      start_sector: 2048, end_sector: 4196351 }] };
  const inventory = await prepare(page, requests, [spare]);
  const section = page.locator('.fm-volume-disk').filter({ hasText: 'Storage Media' });
  await expect(section.getByRole('button', { name: 'Добавить' })).toBeEnabled();
  await section.getByRole('button', { name: 'Разметить' }).click();
  await expect(page.locator('[data-count="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.fm-layout-row')).toHaveCount(1);
  await page.locator('[data-close-action]').first().click();

  await section.getByRole('button', { name: 'Добавить' }).click();
  await page.locator('#fm-volume-form [data-volume-label="0"]').fill('NEW');
  await page.locator('#fm-volume-form [name="confirmation"]').fill('Media1');
  await page.locator('#fm-volume-form button[type="submit"]').click();
  await expect(page.locator('#fm-volumes-progress')).toBeHidden({ timeout: 30000 });
  expect(requests.find((item) => item.path.endsWith('/add')).body.start_sector).toBe(4196352);
  await expect(section).toContainText('NEW');

  const added = section.locator('.fm-volumes-table tr').filter({ hasText: 'NEW' });
  await added.getByRole('button', { name: 'Ещё' }).click();
  await added.locator('xpath=following-sibling::tr[1]').getByRole('button', { name: 'Удалить' }).click();
  await page.locator('#fm-volume-form [name="confirmation"]').fill('Media1');
  await page.locator('#fm-volume-form button[type="submit"]').click();
  await expect(page.locator('#fm-volumes-progress')).toBeHidden({ timeout: 30000 });
  expect(requests.some((item) => item.path.endsWith('/delete'))).toBe(true);

  const original = section.locator('.fm-volumes-table tr').filter({ hasText: 'LAB' });
  await original.getByRole('button', { name: 'Ещё' }).click();
  await original.locator('xpath=following-sibling::tr[1]').getByRole('button', { name: 'Разделить' }).click();
  await page.locator('#fm-volume-form [data-volume-label="0"]').fill('LEFT');
  await page.locator('#fm-volume-form [data-volume-label="1"]').fill('RIGHT');
  await page.locator('#fm-volume-form [name="confirmation"]').fill('Media1');
  await page.locator('#fm-volume-form button[type="submit"]').click();
  await expect(page.locator('#fm-volumes-progress')).toBeHidden({ timeout: 30000 });
  expect(requests.some((item) => item.path.endsWith('/split'))).toBe(true);
  await expect(section).toContainText('RIGHT');

  inventory[0].partitions.forEach((item) => { item.state = 'mounted'; item.empty = true; });
  await page.locator('#fm-volumes-refresh-btn').click();
  const left = section.locator('.fm-volumes-table tr').filter({ hasText: 'LEFT' });
  await left.getByRole('button', { name: 'Ещё' }).click();
  await left.locator('xpath=following-sibling::tr[1]').getByRole('button', { name: 'Объединить' }).click();
  await page.locator('#fm-volume-form [data-volume-label="0"]').fill('JOINED');
  await page.locator('#fm-volume-form [name="confirmation"]').fill('Media1');
  await page.locator('#fm-volume-form button[type="submit"]').click();
  await expect(page.locator('#fm-volumes-progress')).toBeHidden({ timeout: 30000 });
  expect(requests.some((item) => item.path.endsWith('/merge'))).toBe(true);
  await expect(section).toContainText('JOINED');
});
