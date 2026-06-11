import type { ElementContent, Element as HASTElement } from 'hast';

import type { ExpansionDirections, HunkSeparators } from '../types';
import {
  createHastElement,
  createIconElement,
  createTextNodeElement,
} from './hast_utils';

interface CreateSeparatorProps {
  type: HunkSeparators;
  content?: string;
  expandIndex?: number;
  chunked?: boolean;
  slotName?: string;
  isFirstHunk: boolean;
  isLastHunk: boolean;
  /** Render labeled expand buttons instead of icon-only controls. */
  labeled?: boolean;
  /** Collapsed lines remaining in this gap; labels the "All" button. */
  collapsedLines?: number;
  /** Lines revealed per expand click; labels the directional buttons. */
  expansionLineCount?: number;
}

function createExpandButton(type: ExpansionDirections) {
  return createHastElement({
    tagName: 'div',
    children: [
      createIconElement({
        name: type === 'both' ? 'diffs-icon-expand-all' : 'diffs-icon-expand',
        properties: { 'data-icon': '' },
      }),
    ],
    properties: {
      role: 'button',
      'data-expand-button': '',
      'data-expand-both': type === 'both' ? '' : undefined,
      'data-expand-up': type === 'up' ? '' : undefined,
      'data-expand-down': type === 'down' ? '' : undefined,
    },
  });
}

// A labeled expand control: icon plus a "<n> lines" / "All <n> lines" label.
// `all` expands the entire gap; `up`/`down` carry the same direction semantics
// as the icon-only buttons (`down` reveals lines at the bottom of the gap,
// directly above the next hunk, and renders an upward-pointing icon).
function createLabeledExpandButton(
  kind: ExpansionDirections | 'all',
  label: string
) {
  return createHastElement({
    tagName: 'div',
    children: [
      createIconElement({
        name: kind === 'all' ? 'diffs-icon-expand-all' : 'diffs-icon-expand',
        properties: { 'data-icon': '' },
      }),
      createHastElement({
        tagName: 'span',
        children: [createTextNodeElement(label)],
      }),
    ],
    properties: {
      role: 'button',
      'data-expand-button': '',
      'data-expand-label': '',
      'data-expand-up': kind === 'up' ? '' : undefined,
      'data-expand-down': kind === 'down' ? '' : undefined,
      'data-expand-all-button': kind === 'all' ? '' : undefined,
    },
  });
}

// Builds the labeled control row: "<step> lines" / "All <n> lines" /
// "<step> lines". Directional buttons only appear while the remaining gap
// exceeds one expansion step (a single "All" click covers it otherwise), and
// the trailing gap omits the bottom-of-gap button because trailing regions
// only support expanding downward from the last hunk.
function createLabeledExpandButtons({
  collapsedLines,
  expansionLineCount,
  isLastHunk,
}: {
  collapsedLines: number;
  expansionLineCount: number;
  isLastHunk: boolean;
}): ElementContent[] {
  const buttons: ElementContent[] = [];
  const showDirections = collapsedLines > expansionLineCount;
  const stepLabel = `${Math.min(expansionLineCount, collapsedLines)} lines`;
  if (showDirections && !isLastHunk) {
    buttons.push(createLabeledExpandButton('down', stepLabel));
  }
  buttons.push(createLabeledExpandButton('all', `All ${collapsedLines} lines`));
  if (showDirections) {
    buttons.push(createLabeledExpandButton('up', stepLabel));
  }
  return buttons;
}

export function createSeparator({
  type,
  content,
  expandIndex,
  chunked = false,
  slotName,
  isFirstHunk,
  isLastHunk,
  labeled = false,
  collapsedLines = 0,
  expansionLineCount = 100,
}: CreateSeparatorProps): HASTElement {
  let buttonCount = 0;
  const children = [];
  const useLabeledButtons =
    labeled && expandIndex != null && collapsedLines > 0;
  if (type === 'metadata' && content != null) {
    children.push(
      createHastElement({
        tagName: 'div',
        children: [createTextNodeElement(content)],
        properties: { 'data-separator-wrapper': '' },
      })
    );
  }
  if (
    (type === 'line-info' || type === 'line-info-basic') &&
    useLabeledButtons
  ) {
    children.push(
      createHastElement({
        tagName: 'div',
        children: createLabeledExpandButtons({
          collapsedLines,
          expansionLineCount,
          isLastHunk,
        }),
        properties: {
          'data-separator-wrapper': '',
          'data-separator-labeled': '',
        },
      })
    );
  } else if (
    (type === 'line-info' || type === 'line-info-basic') &&
    content != null
  ) {
    const contentChildren: ElementContent[] = [];
    if (expandIndex != null) {
      if (!chunked) {
        contentChildren.push(
          createExpandButton(
            !isFirstHunk && !isLastHunk ? 'both' : isFirstHunk ? 'down' : 'up'
          )
        );
        buttonCount++;
      } else {
        if (!isFirstHunk) {
          contentChildren.push(createExpandButton('up'));
          buttonCount++;
        }
        if (!isLastHunk) {
          contentChildren.push(createExpandButton('down'));
          buttonCount++;
        }
      }
    }
    contentChildren.push(
      createHastElement({
        tagName: 'div',
        children: [
          createHastElement({
            tagName: 'span',
            children: [createTextNodeElement(content)],
            properties: { 'data-unmodified-lines': '' },
          }),
        ],
        properties: { 'data-separator-content': '' },
      })
    );
    if (chunked && expandIndex != null) {
      contentChildren.push(
        createHastElement({
          tagName: 'div',
          children: [createTextNodeElement('Expand all')],
          properties: {
            role: 'button',
            'data-expand-button': '',
            'data-expand-all-button': '',
          },
        })
      );
    }
    children.push(
      createHastElement({
        tagName: 'div',
        children: contentChildren,
        properties: {
          'data-separator-wrapper': '',
          'data-separator-multi-button': buttonCount > 1 ? '' : undefined,
        },
      })
    );
  }
  if (type === 'custom' && slotName != null) {
    children.push(
      createHastElement({
        tagName: 'slot',
        properties: { name: slotName },
      })
    );
  }
  return createHastElement({
    tagName: 'div',
    children,
    properties: {
      'data-separator': children.length === 0 ? 'simple' : type,
      'data-expand-index': expandIndex,
      'data-separator-first': isFirstHunk ? '' : undefined,
      'data-separator-last': isLastHunk ? '' : undefined,
    },
  });
}
