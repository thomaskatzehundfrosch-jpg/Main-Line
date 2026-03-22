import React, { useState } from 'react';
import { X, Copy, Download } from 'lucide-react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  pgnText: string;
  onCopy: () => void;
  onDownload: () => void;
  onOptionsChange: (options: {
    includeAnnotations: boolean;
    filterColor: 'white' | 'black' | 'both';
  }) => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  pgnText,
  onCopy,
  onDownload,
  onOptionsChange,
}) => {
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [filterColor, setFilterColor] = useState<'white' | 'black' | 'both'>('both');

  if (!isOpen) return null;

  const handleAnnotationsChange = (checked: boolean) => {
    setIncludeAnnotations(checked);
    onOptionsChange({
      includeAnnotations: checked,
      filterColor,
    });
  };

  const handleFilterColorChange = (color: 'white' | 'black' | 'both') => {
    setFilterColor(color);
    onOptionsChange({
      includeAnnotations,
      filterColor: color,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 w-[560px] max-h-[80vh] overflow-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-mono text-lg text-text-primary">Export PGN</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Options Section */}
        <div className="mb-6 space-y-4 pb-6 border-b border-border-subtle">
          {/* Include Annotations Checkbox */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="include-annotations"
              checked={includeAnnotations}
              onChange={(e) => handleAnnotationsChange(e.target.checked)}
              className="w-4 h-4 rounded cursor-pointer accent-accent-teal"
            />
            <label
              htmlFor="include-annotations"
              className="text-text-primary text-sm cursor-pointer"
            >
              Include annotations
            </label>
          </div>

          {/* Filter Color Radio Buttons */}
          <div className="space-y-2">
            <p className="text-text-secondary text-sm">Filter:</p>
            <div className="flex gap-6">
              {(['white', 'black', 'both'] as const).map((color) => (
                <div key={color} className="flex items-center gap-2">
                  <input
                    type="radio"
                    id={`filter-${color}`}
                    name="filter-color"
                    value={color}
                    checked={filterColor === color}
                    onChange={() => handleFilterColorChange(color)}
                    className="w-4 h-4 cursor-pointer accent-accent-teal"
                  />
                  <label
                    htmlFor={`filter-${color}`}
                    className="text-text-primary text-sm cursor-pointer capitalize"
                  >
                    {color}
                  </label>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Preview Area */}
        <div className="mb-6">
          <p className="text-text-secondary text-xs mb-2">Preview:</p>
          <textarea
            readOnly
            value={pgnText}
            className="w-full max-h-[300px] overflow-auto bg-bg-primary border border-border-subtle rounded-lg font-mono text-xs text-text-primary p-3 resize-none"
          />
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCopy}
            className="flex-1 btn-secondary flex items-center justify-center gap-2 rounded-lg border border-border-subtle text-text-primary hover:bg-bg-primary transition-colors"
          >
            <Copy size={18} />
            Copy to Clipboard
          </button>
          <button
            onClick={onDownload}
            className="flex-1 btn-primary flex items-center justify-center gap-2 rounded-lg"
          >
            <Download size={18} />
            Download .pgn
          </button>
        </div>
      </div>
    </div>
  );
};
