import React, { useState, useCallback, useRef } from 'react';
import { Save, FolderOpen, Trash2, Edit3, Check, X, FileText, FilePlus, Download, Upload } from 'lucide-react';
import { useFiles } from '../context/FileContext';
import type { TreeNode } from '../types';
import type { RepertoireFile } from '../types/repertoireFile';
import { cloneTree, createRootNode } from '../utils/treeBuilder';
import { downloadAsFile } from '../utils/pgnExporter';

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
    importFilesSnapshot,
  } = useFiles();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setDeleteConfirmId(null);
    setEditingId(file.id);
    setEditName(file.name);
  }, [getNextUntitledName, onLoadTree, saveFile]);

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

  const handleExportBackup = useCallback(() => {
    const payload = {
      app: 'Main Line',
      version: 1,
      exportedAt: new Date().toISOString(),
      files,
    };
    downloadAsFile(
      JSON.stringify(payload, null, 2),
      `mainline-backup-${new Date().toISOString().slice(0, 10)}.json`
    );
  }, [files]);

  const handleImportBackup = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) return;

      try {
        const raw = await selectedFile.text();
        const parsed = JSON.parse(raw);
        const importedFiles = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.files)
            ? parsed.files
            : null;

        if (!importedFiles) {
          throw new Error('Backup file does not contain any repertoire files.');
        }

        importFilesSnapshot(importedFiles as RepertoireFile[]);
      } catch (error) {
        window.alert(
          error instanceof Error
            ? error.message
            : 'Could not import backup file.'
        );
      } finally {
        event.target.value = '';
      }
    },
    [importFilesSnapshot]
  );

  return (
    <div className="flex flex-col gap-2">
      {/* Header actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleNewTree}
          className="btn-secondary flex items-center gap-1.5 text-xs"
          title="Clear the board and start a new empty tree"
        >
          <FilePlus className="w-3.5 h-3.5" />
          New Tree
        </button>
        <button
          onClick={() => activeFileId && handleSaveOver(activeFileId)}
          disabled={!activeFileId}
          className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          title={activeFileId ? 'Save changes to the current repertoire' : 'Create or open a repertoire first'}
        >
          <Save className="w-3.5 h-3.5" />
          Save
        </button>
        <button
          onClick={handleExportBackup}
          className="btn-secondary flex items-center gap-1.5 text-xs"
          title="Download all repertoires as a backup file"
        >
          <Download className="w-3.5 h-3.5" />
          Export Backup
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="btn-secondary flex items-center gap-1.5 text-xs"
          title="Import repertoires from a backup file"
        >
          <Upload className="w-3.5 h-3.5" />
          Import Backup
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportBackup}
          className="hidden"
        />
      </div>

      <div className="text-[10px] text-text-muted">
        Backup sync: export on one device, then import the JSON on the other.
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
