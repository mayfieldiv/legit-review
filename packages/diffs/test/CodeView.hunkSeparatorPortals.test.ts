import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type CodeViewDiffItem,
  type CodeViewItem,
  parseDiffFromFile,
} from '../src';
import { CodeView } from '../src/react/CodeView';

const ROOT_HEIGHT = 800;
const ROOT_WIDTH = 1000;

const originalGlobals = {
  cancelAnimationFrame: Reflect.get(globalThis, 'cancelAnimationFrame'),
  document: Reflect.get(globalThis, 'document'),
  DocumentFragment: Reflect.get(globalThis, 'DocumentFragment'),
  Element: Reflect.get(globalThis, 'Element'),
  HTMLDivElement: Reflect.get(globalThis, 'HTMLDivElement'),
  HTMLElement: Reflect.get(globalThis, 'HTMLElement'),
  HTMLPreElement: Reflect.get(globalThis, 'HTMLPreElement'),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean },
    'IS_REACT_ACT_ENVIRONMENT'
  ),
  Node: Reflect.get(globalThis, 'Node'),
  requestAnimationFrame: Reflect.get(globalThis, 'requestAnimationFrame'),
  ResizeObserver: Reflect.get(globalThis, 'ResizeObserver'),
  SVGElement: Reflect.get(globalThis, 'SVGElement'),
  window: Reflect.get(globalThis, 'window'),
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});

const originalGetBoundingClientRect =
  dom.window.HTMLElement.prototype.getBoundingClientRect;
const originalScrollTo = dom.window.HTMLElement.prototype.scrollTo;

class MockResizeObserver {
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}

beforeAll(() => {
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const isCodeViewRoot =
      this instanceof dom.window.HTMLElement ? this.tabIndex === -1 : false;
    const height = isCodeViewRoot ? ROOT_HEIGHT : 0;
    const width = isCodeViewRoot ? ROOT_WIDTH : 0;
    return {
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    };
  };
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(
    options?: ScrollToOptions | number,
    y?: number
  ) {
    this.scrollTop =
      typeof options === 'number' ? (y ?? 0) : (options?.top ?? this.scrollTop);
  };

  Object.assign(globalThis, {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    document: dom.window.document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    HTMLDivElement: dom.window.HTMLDivElement,
    HTMLElement: dom.window.HTMLElement,
    HTMLPreElement: dom.window.HTMLPreElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    ResizeObserver: MockResizeObserver,
    SVGElement: dom.window.SVGElement,
    window: dom.window,
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  dom.window.HTMLElement.prototype.getBoundingClientRect =
    originalGetBoundingClientRect;
  dom.window.HTMLElement.prototype.scrollTo = originalScrollTo;

  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.assign(globalThis, { [key]: value });
    }
  }
  dom.window.close();
});

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSelector(
  container: HTMLElement,
  selector: string
): Promise<Element | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const element = container.querySelector(selector);
    if (element != null) {
      return element;
    }
    await act(async () => {
      await wait(25);
      await flushReact();
    });
  }
  return container.querySelector(selector);
}

function createDiffItem(): CodeViewDiffItem<undefined> {
  return {
    id: 'diff-1',
    type: 'diff',
    fileDiff: parseDiffFromFile(
      {
        name: 'example.txt',
        contents: 'const value = 1;\n',
      },
      {
        name: 'example.txt',
        contents: 'const value = 2;\n',
      }
    ),
  };
}

describe('React CodeView hunk separator portals', () => {
  test('renders caller content into the hunk separator above the hunk', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const item = createDiffItem();
    let root: Root | undefined;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          createElement(CodeView, {
            disableWorkerPool: true,
            initialItems: [item] satisfies CodeViewItem<undefined>[],
            options: {
              diffStyle: 'unified',
              hunkSeparators: 'line-info-basic',
            },
            renderHunkSeparator(hunk, renderedItem) {
              return createElement(
                'button',
                {
                  'data-hunk-viewed': `${renderedItem.id}:${hunk.hunkIndex}`,
                },
                'Viewed'
              );
            },
          })
        );
        await flushReact();
      });

      const viewedButton = await waitForSelector(
        container,
        '[data-hunk-viewed]'
      );
      const slotHost = viewedButton?.closest('[slot]');

      expect(viewedButton?.textContent).toBe('Viewed');
      expect(viewedButton?.getAttribute('data-hunk-viewed')).toBe('diff-1:0');
      expect(slotHost?.getAttribute('slot')).toBe('hunk-separator-unified-0');
    } finally {
      await act(async () => {
        root?.unmount();
        await flushReact();
      });
      container.remove();
    }
  });
});
