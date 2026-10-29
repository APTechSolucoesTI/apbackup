import { ArrowDown, ArrowUp, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ListQuery } from '@/lib/listing';
export interface TableColumn<T> {
  key: keyof T & string;
  label: string;
  identifier?: boolean;
  mono?: boolean;
  sortable?: boolean;
}
export interface ColumnPreference {
  keys: string[];
  pageSize: ListQuery['pageSize'];
}
export function ColumnSettingsDialog<T>({
  columns,
  value,
  onApply,
}: {
  columns: TableColumn<T>[];
  value: ColumnPreference;
  onApply: (value: ColumnPreference) => void;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(value),
    [order, setOrder] = useState<string[]>(columns.map((c) => c.key));
  const move = (index: number, delta: number) =>
    setOrder((current) => {
      const next = [...current],
        a = next[index],
        b = next[index + delta];
      if (a && b) {
        next[index] = b;
        next[index + delta] = a;
      }
      return next;
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(value);
          setOrder([
            ...value.keys,
            ...columns.map((c) => c.key).filter((k) => !value.keys.includes(k)),
          ]);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 aria-hidden="true" />
          Colunas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configurar colunas</DialogTitle>
          <DialogDescription>
            Ajuste a ordem, a visibilidade e o tamanho da página desta listagem.
          </DialogDescription>
        </DialogHeader>
        <div className="column-options">
          {order.map((key, index) => {
            const col = columns.find((c) => c.key === key)!;
            const identifierCount = columns.filter(
              (c) => c.identifier && draft.keys.includes(c.key),
            ).length;
            return (
              <div className="column-option" key={key}>
                <label>
                  <Checkbox
                    checked={draft.keys.includes(key)}
                    aria-label={col.label}
                    disabled={col.identifier && identifierCount === 1 && draft.keys.includes(key)}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        keys: checked ? [...draft.keys, key] : draft.keys.filter((k) => k !== key),
                      })
                    }
                  />
                  {col.label}
                </label>
                <div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Mover ${col.label} para cima`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Mover ${col.label} para baixo`}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <label className="field-label" htmlFor="page-size">
          Registros por página
        </label>
        <select
          id="page-size"
          className="native-select"
          value={draft.pageSize}
          onChange={(e) =>
            setDraft({ ...draft, pageSize: Number(e.target.value) as ListQuery['pageSize'] })
          }
        >
          {[10, 20, 30, 50, 100].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <DialogFooter className="column-footer">
          <Button
            variant="ghost"
            onClick={() => {
              setDraft({ keys: columns.map((c) => c.key), pageSize: 10 });
              setOrder(columns.map((c) => c.key));
            }}
          >
            Restaurar padrão
          </Button>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onApply({ ...draft, keys: order.filter((k) => draft.keys.includes(k)) });
              setOpen(false);
            }}
          >
            Aplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
