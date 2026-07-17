import type { ReactNode } from "react";

export interface TableColumn {
  key: string;
  label: string;
}

export interface TableShellProps {
  caption: string;
  children: ReactNode;
  columns: readonly TableColumn[];
}

export function TableShell({ caption, children, columns }: TableShellProps) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
