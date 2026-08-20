// 空闲退出的计时器(spec §5.8「无任何已连接客户端持续 45 秒」)。
//
// 单独一个文件、且把时钟以外的一切都做成注入,是为了让这条规则能被**单测**钉住 ——
// 45 秒的用例没人会跑第二次,而它要防的两类错都不报错:退早了(用户开着页面,
// 进程没了)与退不掉(关完标签留一个后台常驻进程)。
//
// 计时的**触发**留在调用方(http/server.ts):谁算「有客户端」、哪些请求算活动,
// 都是那边的知识。这里只负责「多久没被 touch 就喊一声」。

/** 宽限期。取 30-60s 区间中值(spec §5.8)。 */
export const IDLE_EXIT_MS = 45_000;

/** 内部环境变量,名字定在 spec §5.8。不是给用户的开关,不进 `--help` 与 README。 */
export const IDLE_ENV = 'DIFFTAB_IDLE_MS';

export class IdleConfigError extends Error {
  constructor(message: string) {
    super(message);
    // 与 PreflightError / WatchTierError 一致 —— 万一它漏出了 main() 那条
    // instanceof 链,栈顶至少还说得出自己是谁
    this.name = 'IdleConfigError';
  }
}

/**
 * 读宽限期。
 *
 * **取值不合法即启动失败,不退回默认的 45s** —— 与 §5.7 的 `DIFFTAB_WATCH_TIER`
 * 同一条理由:退回时手滑写错的那次照样启动成功、照样跑出一个看着合理的行为,
 * 于是「我验过空闲退出了」建立在一次根本没生效的强制指定上(那条用例会等满 45s
 * 而不是它以为的 800ms,表现为超时,读起来像产品坏了)。
 */
export function resolveIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_ENV];
  if (raw === undefined || raw === '') return IDLE_EXIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new IdleConfigError(
      `${IDLE_ENV} must be a positive number of milliseconds, got "${raw}"`,
    );
  }
  return parsed;
}

export interface IdleWatchdogOptions {
  idleMs: number;
  /** 此刻还有没有已连接的客户端(SSE 连接数)。**每次都现问**,不缓存。 */
  hasClients: () => boolean;
  /** 宽限期走满且仍然没有客户端时调用一次。 */
  onIdle: () => void;
}

export interface IdleWatchdog {
  /**
   * 「刚刚有动静」。有客户端就解除计时,没有就重新起一个完整的宽限期。
   *
   * 只有这一个方法,是因为「有人连上了」「有人断开了」「来了个请求」三件事对本模块
   * 完全同义 —— 它们唯一的区别是调用之后 `hasClients()` 答什么,而那是现问的。
   * 分成 arm / disarm 两个方法则要求每个调用点自己想清楚该调哪个,而想错的两种
   * 症状(退早了 / 退不掉)都不报错。
   */
  touch(): void;
  /** 关服务时停表。停了之后 `touch()` 不再起计时。 */
  stop(): void;
}

export function createIdleWatchdog(options: IdleWatchdogOptions): IdleWatchdog {
  const { idleMs, hasClients, onIdle } = options;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const disarm = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    touch() {
      disarm();
      if (stopped || hasClients()) return;
      timer = setTimeout(() => {
        timer = null;
        /**
         * **落地前再问一次**。定时器排队与回调执行之间隔着整个事件循环的这一圈,
         * 同一圈里完全可能刚接进一个 SSE 连接;而这个判断错了的症状是「用户正开着
         * 页面,进程自己没了」—— 比多活 45 秒糟得多。
         */
        if (stopped || hasClients()) return;
        onIdle();
      }, idleMs);
      /**
       * **计时器不是进程活着的理由**,HTTP server 的监听句柄才是(与 sse.ts 的心跳、
       * watcher 的合并窗口同一条)。不 unref 的话,close() 之后漏了 stop() 就会把
       * 进程多吊住一个宽限期,而那种残留最难看见。
       */
      timer.unref();
    },
    stop() {
      stopped = true;
      disarm();
    },
  };
}
