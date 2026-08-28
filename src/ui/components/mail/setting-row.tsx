import { Switch } from "@/components/ui/switch.tsx";

/**
 * One switch, with the sentence that says what it does.
 *
 * Shared by the Alerts panels rather than duplicated, so a row added under
 * push looks like the rows that were already there.
 */
export function Row({
  icon,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <span className="text-muted-foreground mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <div className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
          {description}
        </div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
