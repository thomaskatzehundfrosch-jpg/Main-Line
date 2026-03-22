import type { TreeNode } from '../types';
import { NAG_SYMBOLS } from '../types';

/**
 * Export a tree (or subtree) back to PGN format with nested RAVs.
 */
export function exportTreeToPgn(
  tree: TreeNode,
  options: {
    includeAnnotations?: boolean;
    filterColor?: 'white' | 'black' | 'both';
  } = {}
): string {
  const { includeAnnotations = true, filterColor = 'both' } = options;

  const headers = [
    '[Event "Opening Repertoire"]',
    '[Site "Main Line"]',
    `[Date "${new Date().toISOString().split('T')[0].replace(/-/g, '.')}"]`,
    '[White "Repertoire"]',
    '[Black "Repertoire"]',
    '[Result "*"]',
  ];

  const moveText = buildMoveText(tree, includeAnnotations, filterColor, 0);

  return [...headers, '', moveText.trim(), '*', ''].join('\n');
}

function buildMoveText(
  node: TreeNode,
  includeAnnotations: boolean,
  filterColor: 'white' | 'black' | 'both',
  moveNumber: number
): string {
  // Filter out any overlay nodes that may have leaked from the D3 visualization
  const realChildren = node.children.filter((c) => !(c as any)._isOverlay);
  if (realChildren.length === 0) return '';

  let result = '';
  let mainChildContinuation = '';

  // For each child, we need to determine if it's a white or black move
  for (let i = 0; i < realChildren.length; i++) {
    const child = realChildren[i];
    const isWhiteMove = child.depth % 2 === 1; // depth 1 = first move = white

    // Apply color filter
    if (filterColor === 'white' && !isWhiteMove && realChildren.length > 1) {
      continue;
    }
    if (filterColor === 'black' && isWhiteMove && realChildren.length > 1) {
      continue;
    }

    const currentMoveNum = Math.ceil(child.depth / 2);

    if (i === 0) {
      // Main line move
      if (isWhiteMove) {
        result += `${currentMoveNum}. ${child.move}`;
      } else {
        result += `${currentMoveNum}... ${child.move}`;
      }

      // Add NAGs
      if (includeAnnotations && child.nags.length > 0) {
        for (const nag of child.nags) {
          const nagInfo = NAG_SYMBOLS[nag];
          if (nagInfo) {
            result += ` $${nag}`;
          }
        }
      }

      // Add comment
      if (includeAnnotations && child.comment) {
        result += ` {${child.comment}}`;
      }

      result += ' ';

      // Save main line continuation for AFTER variations
      mainChildContinuation = buildMoveText(child, includeAnnotations, filterColor, currentMoveNum);
    } else {
      // Variation (RAV) — written BEFORE the main line continuation
      result += '(';
      if (isWhiteMove) {
        result += `${currentMoveNum}. ${child.move}`;
      } else {
        result += `${currentMoveNum}... ${child.move}`;
      }

      if (includeAnnotations && child.nags.length > 0) {
        for (const nag of child.nags) {
          result += ` $${nag}`;
        }
      }

      if (includeAnnotations && child.comment) {
        result += ` {${child.comment}}`;
      }

      result += ' ';
      result += buildMoveText(child, includeAnnotations, filterColor, currentMoveNum);
      result = result.trimEnd() + ') ';
    }
  }

  // Append main line continuation AFTER all variations
  result += mainChildContinuation;

  return result;
}

/**
 * Copy text to clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Download text as a file.
 */
export function downloadAsFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
