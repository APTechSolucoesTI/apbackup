import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { ReactNode } from 'react';
import type { TableColumn } from './column-settings-dialog';
import type { ListQuery, ListResult } from '@/lib/listing';
import { humanLabel } from '@/lib/listing';
export function Pagination({ data, onPage }: { data: ListResult; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <nav className="pagination" aria-label="Paginação da listagem">
      <span className="tabular-nums">
        {data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1}–
        {Math.min(data.total, data.page * data.pageSize)} de {data.total}
      </span>
      <div>
        <span>
          Página {data.page} de {pages}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Anterior"
          disabled={data.page <= 1}
          onClick={() => onPage(data.page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Próxima"
          disabled={data.page >= pages}
          onClick={() => onPage(data.page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
export function ConfigurableTable<T extends { id: string }>({
  items,
  columns,
  sort,
  direction,
  onSort,
  render,
  actions,
}: {
  items: T[];
  columns: TableColumn<T>[];
  sort: ListQuery['sort'];
  direction: ListQuery['direction'];
  onSort: (key: string) => void;
  render?: (key: string, item: T) => ReactNode;
  actions?: (item: T) => ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead
              key={col.key}
              aria-sort={
                sort === col.key && direction !== 'none'
                  ? direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              }
            >
              {col.sortable === false ? (
                <span>{col.label}</span>
              ) : (
                <button className="sort-button" onClick={() => onSort(col.key)}>
                  {col.label}
                  {sort === col.key && direction !== 'none' ? (
                    direction === 'asc' ? (
                      <ArrowUp />
                    ) : (
                      <ArrowDown />
                    )
                  ) : (
                    <ArrowUpDown />
                  )}
                </button>
              )}
            </TableHead>
          ))}
          {actions && <TableHead className="row-actions-column">Ações</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            {columns.map((col) => {
              const value = String(item[col.key] ?? '');
              return (
                <TableCell key={col.key} className={col.mono ? 'font-mono' : ''}>
                  {render?.(col.key, item) ??
                    (col.key === 'status' ? (
                      <Badge variant="outline" className={`status-badge status-${value}`}>
                        {humanLabel(value)}
                      </Badge>
                    ) : col.key === 'createdAt' ? (
                      <time dateTime={value}>
                        {format(new Date(value), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                      </time>
                    ) : (
                      <span className="cell-text" title={value}>
                        {humanLabel(value)}
                      </span>
                    ))}
                </TableCell>
              );
            })}
            {actions && <TableCell className="row-actions-column">{actions(item)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
