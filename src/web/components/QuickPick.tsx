// quick pick 的外壳，照 VS Code 顶部居中弹出的那个：一个输入框，下面一列可选项。**分支列表与 Quick
// Open 共用这一份**——弹层、`combobox` / `listbox`、键盘、外部点击、200 条上限、活动项滚进视野这些
// 易漏的机制只写一次，理由同 `Sash.tsx`：两份副本时修了一份、另一份静默坏着。每一项长什么样、选中
// 意味着什么、取不到时说什么，归调用方。

import { useComputed, useSignal } from '@preact/signals';
import { Component, type ComponentType, type RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { SELECTED } from './tree-row';

/**
 * 一次最多画多少条。几千个标签、几万个文件的仓库里整份列表同时挂进 DOM 是一次可感知的卡顿，而这份
 * 列表本来就是拿来搜的。
 */
export const MAX_SHOWN = 200;

/**
 * 每一项的内容组件收到的 props：`item` 本身、它是不是本组第一项（按 `groupOf` 判），以及整个列表
 * 共用的那一个 `context`（分支列表是当前分支名）。**全是值**：行按 props 逐个浅比较。
 */
export interface RowProps<T, C> {
  item: T;
  first: boolean;
  context: C;
}

export interface QuickPickProps<T, C> {
  /** 元素 id 的前缀：同一页里两个 quick pick 的 id 不能撞。 */
  idPrefix: string;
  /** 浮层的 `aria-label`。 */
  label: string;
  /** 输入框的 `aria-label` 与 `placeholder`。 */
  inputLabel: string;
  placeholder: string;
  /** 打开它的那枚按钮。按在它上面不算「外面」——开关归它自己的 click。 */
  anchor: RefObject<HTMLElement>;
  /**
   * 按输入框的内容给出全部命中项，次序就是画的次序。**在一个 computed 里调**：里面读到的 signal
   * 都会被订阅，于是只随数据与输入框变——鼠标在行间移动每一步都重画，不该每步重新过滤一遍。
   */
  match: (query: string) => readonly T[];
  keyOf: (item: T) => string;
  /**
   * 每一项的内容。**身份必须稳定**（模块级组件）：行按 props 逐个浅比较，组件每次都是新的就挡不住
   * 重画。
   */
  Row: ComponentType<RowProps<T, C>>;
  /** 分组键：与上一项不同即本组第一项，第二组起顶上画一条分隔线。不给即不分组。 */
  groupOf?: (item: T) => string;
  context: C;
  /** 列表本身的状态（在取、出错、源头为空）；`null` 即列表就绪，此时没有命中才说 `noMatch`。 */
  status: string | null;
  /** 没有命中时说什么，按输入框的内容分说法（空输入与没搜到可以是两句话）。 */
  noMatch: (query: string) => string;
  onPick: (item: T) => void;
  onClose: () => void;
}

export function QuickPick<T, C>({
  idPrefix,
  label,
  inputLabel,
  placeholder,
  anchor,
  match,
  keyOf,
  Row,
  groupOf,
  context,
  status,
  noMatch,
  onPick,
  onClose,
}: QuickPickProps<T, C>) {
  const query = useSignal('');
  const active = useSignal(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // 宿主每次重画都给一个新的 `onClose`（agent 跑动时 SSE 每 150ms 一次）；放进 ref，下面那条
  // document 监听就只挂一次，不随每次重画拆了又装
  const close = useRef(onClose);
  close.current = onClose;
  const optionId = (index: number) => `${idPrefix}-option-${index}`;
  const listboxId = `${idPrefix}-listbox`;

  // `autoFocus` 在 Preact 里不可靠（挂载时元素还不在文档里），这里手动给
  useEffect(() => {
    input.current?.focus();
  }, []);

  // 按在浮层之外任何地方即关。挂在 document 上而不是垫一层透明遮罩：遮罩会吞掉那一下，用户点左栏
  // 一个文件得点两次。**用 layout effect**：普通 effect 在绘制之后才挂，浮层画出来到监听生效之间
  // 有一段空窗，那一下点在外面不会关
  useLayoutEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dialog.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [anchor]);

  const matches = useComputed(() => match(query.value)).value;
  const shown = matches.slice(0, MAX_SHOWN);
  const activeIndex = Math.min(active.value, Math.max(shown.length - 1, 0));

  // 键盘移动时把活动项滚进视野；鼠标悬停设的活动项本来就在视野里，`nearest` 不会动它
  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const pick = (item: T | undefined) => {
    if (item === undefined) return;
    onClose();
    onPick(item);
  };
  // 交给行的回调**身份不变**，`Option` 的浅比较才挡得住：宿主每次 SSE 重画都给新的 `onPick` /
  // `onClose`，悬停每换一行都改 `active`，两者都不该让 200 行全部重画
  const latestPick = useRef(pick);
  latestPick.current = pick;
  const pickRow = useCallback((item: unknown) => latestPick.current(item as T), []);
  const hoverRow = useCallback(
    (index: number) => {
      if (active.value !== index) active.value = index;
    },
    [active],
  );
  const latestKeyDown = useRef<(event: KeyboardEvent) => void>(() => {});
  const keyDownRow = useCallback((event: KeyboardEvent) => latestKeyDown.current(event), []);

  const onKeyDown = (event: KeyboardEvent) => {
    const count = shown.length;
    // 读 signal 而不是渲染时那份 `activeIndex`：两次按键之间未必重画过，按闭包里的值算时连按三下
    // 只走一格，`↓` 紧跟 `Enter` 选中的是上一项
    const current = Math.min(active.value, count - 1);
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(shown[current]);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) {
      event.preventDefault();
      // 首尾相接，与 quick pick 一致
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active.value = (current + step + count) % count;
    }
  };
  latestKeyDown.current = onKeyDown;

  const message = status ?? (shown.length === 0 ? noMatch(query.value) : null);

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-label={label}
      class="fixed top-2 left-1/2 z-50 flex w-150 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-md border border-panel-border bg-side-bar-background p-1 text-sm shadow-lg"
    >
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-activedescendant={shown.length > 0 ? optionId(activeIndex) : undefined}
        aria-label={inputLabel}
        placeholder={placeholder}
        spellcheck={false}
        autocomplete="off"
        value={query.value}
        onInput={(event) => {
          query.value = event.currentTarget.value;
          active.value = 0;
        }}
        onKeyDown={onKeyDown}
        class="mb-1 rounded-sm border border-focus-border bg-editor-background px-2 py-1 outline-none"
      />
      {message !== null && <p class="px-2 py-1 text-description-foreground">{message}</p>}
      <div id={listboxId} role="listbox" class="max-h-110 overflow-auto">
        {shown.map((item, index) => {
          const previous = shown[index - 1];
          const first =
            groupOf !== undefined &&
            (previous === undefined || groupOf(previous) !== groupOf(item));
          return (
            <Option
              key={keyOf(item)}
              id={optionId(index)}
              item={item}
              index={index}
              selected={index === activeIndex}
              first={first}
              context={context}
              Row={Row as ComponentType<RowProps<unknown, unknown>>}
              onHover={hoverRow}
              onPick={pickRow}
              onKeyDown={keyDownRow}
            />
          );
        })}
      </div>
      {matches.length > shown.length && (
        <p class="px-2 py-1 text-xs text-description-foreground">
          {matches.length - shown.length} more — type to filter
        </p>
      )}
    </div>
  );
}

interface OptionProps {
  id: string;
  item: unknown;
  index: number;
  selected: boolean;
  first: boolean;
  context: unknown;
  Row: ComponentType<RowProps<unknown, unknown>>;
  onHover: (index: number) => void;
  onPick: (item: unknown) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * 一项。**props 逐个浅比较、都没变就不重画**：props 全是值或身份不变的回调，于是 SSE 重画与悬停换行
 * 只重画真变了的那一两行。不用 `preact/compat` 的 `memo`——为它整个 compat 层进产物要多 6 KB。
 */
class Option extends Component<OptionProps> {
  override shouldComponentUpdate(next: OptionProps): boolean {
    const keys = Object.keys(next) as (keyof OptionProps)[];
    return keys.some((key) => next[key] !== this.props[key]);
  }

  override render() {
    const { id, item, index, selected, first, context, Row, onHover, onPick, onKeyDown } =
      this.props;
    return (
      <div
        id={id}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        class={`cursor-pointer rounded-sm px-2 py-0.5 ${selected ? SELECTED : ''} ${first && index > 0 ? 'mt-1 border-t border-panel-border' : ''}`}
        onMouseMove={() => onHover(index)}
        onClick={() => onPick(item)}
        // 焦点平时留在输入框里（`aria-activedescendant`），单击的那一瞬才落到这一项上；
        // 那时键盘照样按输入框那一套走
        onKeyDown={onKeyDown}
      >
        <Row item={item} first={first} context={context} />
      </div>
    );
  }
}
