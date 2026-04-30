export interface MockScrollMetrics {
  readonly maxScrollTop: number;
  readonly scrollTop: number;
  setScrollTop: (top: number) => void;
  setScrollHeight: (height: number) => void;
  setClientHeight: (height: number) => void;
  getScrollTop: () => number;
  getMaxScrollTop: () => number;
}

export function mockScrollMetrics(
  element: HTMLElement,
  options: {
    initialScrollTop?: number;
    scrollTop?: number;
    scrollHeight?: number;
    clientHeight?: number;
  } = {}
): MockScrollMetrics {
  let scrollHeight = options.scrollHeight ?? 1300;
  let clientHeight = options.clientHeight ?? 400;
  const maxScrollTop = () => Math.max(0, scrollHeight - clientHeight);
  const clampScrollTop = (nextValue: number) => Math.min(maxScrollTop(), Math.max(0, nextValue));
  let scrollTop = clampScrollTop(options.initialScrollTop ?? options.scrollTop ?? maxScrollTop());

  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (nextValue: number) => {
      scrollTop = clampScrollTop(nextValue);
    },
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });

  return {
    get maxScrollTop() {
      return maxScrollTop();
    },
    get scrollTop() {
      return scrollTop;
    },
    setScrollTop(nextValue) {
      scrollTop = clampScrollTop(nextValue);
    },
    setScrollHeight(nextValue) {
      scrollHeight = nextValue;
      scrollTop = clampScrollTop(scrollTop);
    },
    setClientHeight(nextValue) {
      clientHeight = nextValue;
      scrollTop = clampScrollTop(scrollTop);
    },
    getScrollTop() {
      return scrollTop;
    },
    getMaxScrollTop: maxScrollTop,
  };
}
