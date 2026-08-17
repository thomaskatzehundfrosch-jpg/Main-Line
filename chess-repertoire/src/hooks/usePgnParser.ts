import { useState, useCallback } from 'react';
import { parse } from '@mliebelt/pgn-parser';
import { buildTreeFromGames } from '../utils/treeBuilder';
import { sanitizePgnForParser } from '../utils/pgnSanitizer';
import type { TreeNode } from '../types';

interface UsePgnParserReturn {
  isLoading: boolean;
  error: string | null;
  parsedTree: TreeNode | null;
  nodeMap: Map<string, TreeNode> | null;
  gameCount: number;
  parsePgnText: (pgnText: string) => Promise<void>;
  parsePgnFile: (file: File) => Promise<void>;
  parsePgnFiles: (files: FileList) => Promise<void>;
  clearParsed: () => void;
}

export function usePgnParser(): UsePgnParserReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsedTree, setParsedTree] = useState<TreeNode | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, TreeNode> | null>(null);
  const [gameCount, setGameCount] = useState(0);

  const parsePgnText = useCallback(async (pgnText: string) => {
    setIsLoading(true);
    setError(null);

    try {
      // Parse the PGN text using @mliebelt/pgn-parser
      const parsedGames = parse(sanitizePgnForParser(pgnText), { startRule: 'games' });

      // Ensure parsedGames is an array
      const gamesArray = Array.isArray(parsedGames) ? parsedGames : [parsedGames];

      // Build the tree from the parsed games
      const { tree, nodeMap: resultNodeMap } = buildTreeFromGames(gamesArray);

      // Update state with results
      setParsedTree(tree);
      setNodeMap(resultNodeMap);
      setGameCount(gamesArray.length);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to parse PGN text';
      setError(errorMessage);
      setParsedTree(null);
      setNodeMap(null);
      setGameCount(0);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const parsePgnFile = useCallback(
    async (file: File) => {
      setIsLoading(true);
      setError(null);

      try {
        // Read the file content
        const fileContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            const content = event.target?.result;
            if (typeof content === 'string') {
              resolve(content);
            } else {
              reject(new Error('Failed to read file content'));
            }
          };
          reader.onerror = () => reject(new Error('File read error'));
          reader.readAsText(file);
        });

        // Parse the file content
        await parsePgnText(fileContent);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to parse PGN file';
        setError(errorMessage);
        setParsedTree(null);
        setNodeMap(null);
        setGameCount(0);
        setIsLoading(false);
      }
    },
    [parsePgnText]
  );

  const parsePgnFiles = useCallback(
    async (files: FileList) => {
      setIsLoading(true);
      setError(null);

      try {
        // Read all files and concatenate their content
        const fileContents: string[] = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileContent = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
              const content = event.target?.result;
              if (typeof content === 'string') {
                resolve(content);
              } else {
                reject(new Error(`Failed to read file: ${file.name}`));
              }
            };
            reader.onerror = () => reject(new Error(`File read error: ${file.name}`));
            reader.readAsText(file);
          });
          fileContents.push(fileContent);
        }

        // Concatenate all file contents with newlines
        const concatenatedContent = fileContents.join('\n');

        // Parse the combined content
        await parsePgnText(concatenatedContent);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to parse PGN files';
        setError(errorMessage);
        setParsedTree(null);
        setNodeMap(null);
        setGameCount(0);
        setIsLoading(false);
      }
    },
    [parsePgnText]
  );

  const clearParsed = useCallback(() => {
    setIsLoading(false);
    setError(null);
    setParsedTree(null);
    setNodeMap(null);
    setGameCount(0);
  }, []);

  return {
    isLoading,
    error,
    parsedTree,
    nodeMap,
    gameCount,
    parsePgnText,
    parsePgnFile,
    parsePgnFiles,
    clearParsed,
  };
}
