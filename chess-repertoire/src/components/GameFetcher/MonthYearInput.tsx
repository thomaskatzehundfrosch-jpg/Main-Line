import React, { useMemo } from 'react';

const MONTH_OPTIONS = [
  { value: '01', label: 'Jan' },
  { value: '02', label: 'Feb' },
  { value: '03', label: 'Mar' },
  { value: '04', label: 'Apr' },
  { value: '05', label: 'May' },
  { value: '06', label: 'Jun' },
  { value: '07', label: 'Jul' },
  { value: '08', label: 'Aug' },
  { value: '09', label: 'Sep' },
  { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' },
  { value: '12', label: 'Dec' },
] as const;

function parseMonthValue(value: string): { year: string; month: string } {
  const [year = '', month = '01'] = value.split('-');
  return { year, month };
}

interface MonthYearInputProps {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
}

export const MonthYearInput: React.FC<MonthYearInputProps> = ({
  label,
  value,
  onChange,
}) => {
  const { year, month } = parseMonthValue(value);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years: string[] = [];
    for (let y = currentYear + 1; y >= 1990; y--) {
      years.push(String(y));
    }
    return years;
  }, []);

  const updateMonth = (nextMonth: string) => {
    onChange(`${year || String(new Date().getFullYear())}-${nextMonth}`);
  };

  const updateYear = (nextYear: string) => {
    onChange(`${nextYear}-${month || '01'}`);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <select
          value={month}
          onChange={(e) => updateMonth(e.target.value)}
          className="h-9 px-3 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-sm outline-none focus:border-accent-teal transition-colors"
        >
          {MONTH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => updateYear(e.target.value)}
          className="h-9 px-3 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-sm outline-none focus:border-accent-teal transition-colors"
        >
          {yearOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
