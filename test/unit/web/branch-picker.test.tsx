// 分支列表：从状态条打开、过滤、键盘走动、选中即复制、关掉后焦点回到那枚按钮。fetch 与剪贴板一律
// 打桩——这里钉的是「选中」只有复制这一种含义，以及两条看不出来的失误：活动项越界与焦点丢回 body。

import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchState, RefEntry } from '../../../src/server/shared/protocol';
import { BranchStatus } from '../../../src/web/components/BranchStatus';
import { filterRefs, MAX_SHOWN, refList, refsError } from '../../../src/web/state/refs';
import { stubClipboard, stubJson, waitFor } from './helpers';

const branch: BranchState = { head: 'main', detached: false, upstream: null };

const ref = (kind: RefEntry['kind'], name: string, subject = `tip of ${name}`): RefEntry => ({
  kind,
  name,
  sha: 'a'.repeat(40),
  author: 'Ada',
  time: 1_700_000_000,
  subject,
});

const REFS: RefEntry[] = [
  ref('local', 'main'),
  ref('local', 'feature/login'),
  ref('remote', 'origin/main'),
  ref('tag', 'v1.0'),
];

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  refList.value = null;
  refsError.value = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup]');
const input = () => container.querySelector<HTMLInputElement>('[role="combobox"]');
const options = () => [...container.querySelectorAll('[role="option"]')];
const press = (key: string) =>
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

async function open(refs: RefEntry[] = REFS) {
  const calls = stubJson({ refs });
  render(<BranchStatus branch={branch} />, container);
  trigger()?.click();
  await waitFor(() => expect(options()).toHaveLength(Math.min(refs.length, MAX_SHOWN)));
  return calls;
}

describe('BranchPicker', () => {
  it('点分支名才打开，打开时取一次 /api/refs、输入框拿到焦点', async () => {
    const calls = stubJson({ refs: REFS });
    render(<BranchStatus branch={branch} />, container);
    expect(container.querySelector('[role="dialog"]')).toBe(null);
    expect(calls).toEqual([]);
    trigger()?.click();
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(calls).toEqual(['/api/refs']);
    expect(document.activeElement).toBe(input());
  });

  it('三组各在第一项右端标组名，当前分支那一项带一枚 ✓', async () => {
    await open();
    const texts = options().map((o) => o.textContent ?? '');
    expect(texts[0]).toContain('branches');
    expect(texts[1]).not.toContain('branches');
    expect(texts[2]).toContain('remote branches');
    expect(texts[3]).toContain('tags');
    // main 那一项多一枚图标（✓），feature/login 只有分支那一枚
    expect(options()[0]?.querySelectorAll('svg')).toHaveLength(2);
    expect(options()[1]?.querySelectorAll('svg')).toHaveLength(1);
    expect(texts[0]).toContain('Ada • aaaaaaa • tip of main');
  });

  it('按名字过滤，输入一变活动项回到第一项', async () => {
    await open();
    press('ArrowDown');
    await waitFor(() => expect(options()[1]?.getAttribute('aria-selected')).toBe('true'));
    const box = input();
    if (!box) throw new Error('no input');
    box.value = 'MAIN';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
  });

  it('↑ / ↓ 首尾相接，Enter 复制活动项的名字并关闭、焦点回到那枚按钮', async () => {
    const writeText = stubClipboard();
    await open();
    press('ArrowUp');
    await waitFor(() => expect(options()[3]?.getAttribute('aria-selected')).toBe('true'));
    // 连按、中间不等重画：活动项按 signal 算，不按渲染时的闭包
    for (const _ of [1, 2, 3]) press('ArrowDown');
    press('Enter');
    expect(writeText).toHaveBeenCalledWith('origin/main');
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));
    expect(document.activeElement).toBe(trigger());
    await waitFor(() => expect(trigger()?.title).toBe('Copied origin/main'));
  });

  it('单击一项即复制；Esc 与点外面都只关闭、不复制', async () => {
    const writeText = stubClipboard();
    await open();
    press('Escape');
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));

    trigger()?.click();
    await waitFor(() => expect(options()).toHaveLength(4));
    container
      .querySelector('[role="dialog"]')
      ?.parentElement?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));
    expect(writeText).not.toHaveBeenCalled();

    trigger()?.click();
    await waitFor(() => expect(options()).toHaveLength(4));
    (options()[3] as HTMLElement).click();
    expect(writeText).toHaveBeenCalledWith('v1.0');
  });

  it('开着时再点一次分支名即关，不会关了又开', async () => {
    const calls = await open();
    const button = trigger();
    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button?.click();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));
    expect(calls).toEqual(['/api/refs']);
  });

  it('上一次取失败的错误不留到下一次，也不与旧列表并排', async () => {
    await open();
    trigger()?.click();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));
    stubJson({ error: { code: 'internal', message: 'git exploded' } }, 500);
    trigger()?.click();
    await waitFor(() => expect(container.textContent).toContain('git exploded'));
    expect(options()).toHaveLength(0);

    trigger()?.click();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));
    stubJson({ refs: REFS });
    trigger()?.click();
    expect(container.textContent).not.toContain('git exploded');
    await waitFor(() => expect(options()).toHaveLength(4));
  });

  it('剪贴板不可用时同步抛错也照样关掉列表', async () => {
    await open();
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => {
      throw new TypeError('no clipboard');
    });
    press('Enter');
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBe(null));
    expect(trigger()?.title).toBe('main');
  });

  it('一条 ref 都没有时说一句话，而不是一块空白', async () => {
    stubJson({ refs: [] });
    render(<BranchStatus branch={branch} />, container);
    trigger()?.click();
    await waitFor(() => expect(container.textContent).toContain('No branches or tags'));
  });

  it('超出上限的只画前 200 条，并说还有多少', async () => {
    const many = Array.from({ length: MAX_SHOWN + 5 }, (_, i) => ref('tag', `t${i}`));
    await open(many);
    expect(container.textContent).toContain('5 more — type to filter');
  });
});

describe('filterRefs', () => {
  it('不区分大小写的子串匹配，次序原样保留；空串回全部', () => {
    expect(filterRefs(REFS, ' Main ').map((r) => r.name)).toEqual(['main', 'origin/main']);
    expect(filterRefs(REFS, '')).toHaveLength(4);
  });
});
