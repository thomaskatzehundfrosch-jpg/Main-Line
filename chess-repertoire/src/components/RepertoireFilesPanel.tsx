import React, { useState, useCallback } from 'react';
import { Save, FolderOpen, Trash2, Edit3, Check, X, Plus, FileText, FilePlus } from 'lucide-react';
import { useFiles } from '../context/FileContext';
import { useGames } from '../context/GameContext';
import type { TreeNode } from '../types';
import type { RepertoireFile } from '../types/repertoireFile';
import { cloneTree, createRootNode } from '../utils/treeBuilder';

interface RepertoireFilesPanelProps {
  currentTree: TreeNode;
  onLoadTree: (tree: TreeNode) => void;
}

export const RepertoireFilesPanel: React.FC<RepertoireFilesPanelProps> = ({
  currentTree,
  onLoadTree,
}) => {
  const {
    files,
    activeFileId,
    saveFile,
    updateFile,
    deleteFile,
    renameFile,
    setActive,
  } = useFiles();

  const { importedGames } = useGames();

  const [saveMode, setSaveMode] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const getNextUntitledName = useCallback(() => {
    const existingNames = new Set(files.map((file) => file.name.trim().toLowerCase()));
    if (!existingNames.has('untitled repertoire')) {
      return 'Untitled Repertoire';
    }

    let index = 2;
    while (existingNames.has(`untitled repertoire ${index}`)) {
      index += 1;
    }
    return `Untitled Repertoire ${index}`;
  }, [files]);

  const handleNewTree = useCallback(() => {
    const tree = createRootNode();
    const file = saveFile(getNextUntitledName(), tree, []);
    onLoadTree(tree);
    setSaveMode(false);
    setNewFileName('');
    setDeleteConfirmId(null);
    setEditingId(file.id);
    setEditName(file.name);
  }, [getNextUntitledName, onLoadTree, saveFile]);

  const handleSaveNew = useCallback(() => {
    const name = newFileName.trim();
    if (!name) return;
    saveFile(name, currentTree, importedGames);
    setNewFileName('');
    setSaveMode(false);
  }, [newFileName, currentTree, importedGames, saveFile]);

  const handleSaveOver = useCallback(
    (id: string) => {
      updateFile(id, currentTree);
    },
    [currentTree, updateFile]
  );

  const handleLoad = useCallback(
    (file: RepertoireFile) => {
      onLoadTree(cloneTree(file.tree));
      setActive(file.id);
    },
    [onLoadTree, setActive]
  );

  const handleRename = useCallback(
    (id: string) => {
      const name = editName.trim();
      if (!name) return;
      renameFile(id, name);
      setEditingId(null);
    },
    [editName, renameFile]
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteFile(id);
      setDeleteConfirmId(null);
    },
    [deleteFile]
  );

  const startEditing = (file: RepertoireFile) => {
    setEditingId(file.id);
    setEditName(file.name);
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Header actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleNewTree}
          className="btn-secondary flex items-center gap-1.5 text-xs"
          title="Clear the board and start a new empty tree"
        >
          <FilePlus className="w-3.5 h-3.5" />
          New Tree
        </button>
        {!saveMode ? (
          <button
            onClick={() => setSaveMode(true)}
            className="btn-primary flex items-center gap-1.5 text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            Save Current
          </button>
        ) : (
          <div className="flex items-center gap-1.5 flex-1">
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveNew();
                if (e.key === 'Escape') setSaveMode(false);
              }}
              placeholder="Repertoire name..."
              autoFocus
              className="flex-1 bg-bg-primary border border-border-subtle rounded-md px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-teal/50"
            />
            <button
              onClick={handleSaveNew}
              disabled={!newFileName.trim()}
              className="btn-icon p-1 text-accent-green disabled:opacity-30"
              title="Save"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setSaveMode(false)}
              className="btn-icon p-1"
              title="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* File list */}
      {files.length > 0 ? (
        <div className="flex flex-col gap-1">
          {files.map((file) => {
            const isActive = file.id === activeFileId;
            const isEditing = editingId === file.id;
            const isDeleting = deleteConfirmId === file.id;

            return (
              <div
                key={file.id}
                onClick={() => !isActive && !isEditing && !isDeleting && handleLoad(file)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 group transition-colors ${
                  isActive
                    ? 'bg-accent-teal/10 border border-accent-teal/30'
                    : 'bg-bg-primary border border-border-subtle hover:border-border-active cursor-pointer'
                }`}
              >
                <FileText
                  className={`w-3.5 h-3.5 flex-shrink-0 ${
                    isActive ? 'text-accent-teal' : 'text-text-muted'
                  }`}
                />

                {/* Name / edit */}
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(file.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        autoFocus
                        className="flex-1 bg-bg-hover border border-border-active rounded px-1 py-0.5 text-xs text-text-primary focus:outline-none"
                      />
                      <button
                        onClick={() => handleRename(file.id)}
                        className="btn-icon p-0.5 text-accent-green"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="btn-icon p-0.5"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div
                        className={`text-xs truncate ${
                          isActive ? 'text-accent-teal font-medium' : 'text-text-primary'
                        }`}
                      >
                        {file.name}
                      </div>
                      <div className="text-[10px] text-text-muted flex items-center gap-2">
                        <span>{file.nodeCount} nodes</span>
                        <span>{formatDate(file.updatedAt)}</span>
                      </div>
                    </>
                  )}
                </div>

                {/* Actions */}
                {!isEditing && !isDeleting && (
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!isActive && (
                      <button
                        onClick={() => handleLoad(file)}
                        className="btn-icon p-1"
                        title="Load repertoire"
                      >
                        <FolderOpen className="w-3 h-3 text-accent-teal" />
                      </button>
                    )}
                    {isActive && (
                      <button
                        onClick={() => handleSaveOver(file.id)}
                        className="btn-icon p-1"
                        title="Save changes"
                      >
                        <Save className="w-3 h-3 text-accent-green" />
                      </button>
                    )}
                    <button
                      onClick={() => startEditing(file)}
                      className="btn-icon p-1"
                      title="Rename"
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(file.id)}
                      className="btn-icon p-1"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3 text-accent-red" />
                    </button>
                  </div>
                )}

                {/* Delete confirmation */}
                {isDeleting && (
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-[10px] text-accent-red">Delete?</span>
                    <button
                      onClick={() => handleDelete(file.id)}
                      className="text-[10px] text-accent-red hover:text-accent-red/80"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      className="text-[10px] text-text-muted"
                    >
                      No
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center text-text-muted text-xs py-4">
          No saved repertoires yet. Create a new tree or import a PGN to get started.
        </div>
      )}
    </div>
  );
};
