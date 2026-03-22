import React, { useState, useRef } from 'react';
import { X, Upload } from 'lucide-react';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (pgnText: string) => void;
  onImportFiles: (files: FileList) => void;
  isLoading: boolean;
  error: string | null;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  onClose,
  onImport,
  onImportFiles,
  isLoading,
  error,
}) => {
  const [activeTab, setActiveTab] = useState<'paste' | 'upload'>('paste');
  const [pgnText, setPgnText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleImport = () => {
    if (activeTab === 'paste') {
      onImport(pgnText);
      setPgnText('');
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      onImportFiles(event.target.files);
      setPgnText('');
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.files) {
      onImportFiles(event.dataTransfer.files);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 w-[560px] max-h-[80vh] overflow-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-mono text-lg text-text-primary">Import PGN</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-6 mb-6 border-b border-border-subtle">
          <button
            onClick={() => setActiveTab('paste')}
            className={`pb-3 font-mono text-sm transition-colors ${
              activeTab === 'paste'
                ? 'text-accent-teal border-b-2 border-accent-teal'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Paste PGN
          </button>
          <button
            onClick={() => setActiveTab('upload')}
            className={`pb-3 font-mono text-sm transition-colors ${
              activeTab === 'upload'
                ? 'text-accent-teal border-b-2 border-accent-teal'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Upload File
          </button>
        </div>

        {/* Content */}
        {activeTab === 'paste' ? (
          <textarea
            value={pgnText}
            onChange={(e) => setPgnText(e.target.value)}
            placeholder="Paste PGN text here..."
            className="w-full h-64 bg-bg-primary border border-border-subtle rounded-lg font-mono text-sm text-text-primary p-3 resize-none focus:outline-none focus:ring-2 focus:ring-accent-teal"
          />
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pgn"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
              className="w-full h-64 border-2 border-dashed border-border-subtle rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-accent-teal hover:bg-bg-primary/50 transition-colors"
            >
              <Upload size={32} className="text-text-secondary mb-3" />
              <p className="text-text-secondary text-sm text-center px-4">
                Drop .pgn files here or click to browse
              </p>
            </div>
          </>
        )}

        {/* Error Display */}
        {error && <p className="text-accent-red text-sm mt-3">{error}</p>}

        {/* Import Button */}
        <button
          onClick={handleImport}
          disabled={isLoading || (activeTab === 'paste' && !pgnText.trim())}
          className="btn-primary w-full mt-4 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <>
              <div className="w-4 h-4 border-2 border-accent-teal border-t-transparent rounded-full animate-spin" />
              Importing...
            </>
          ) : (
            'Import'
          )}
        </button>
      </div>
    </div>
  );
};
