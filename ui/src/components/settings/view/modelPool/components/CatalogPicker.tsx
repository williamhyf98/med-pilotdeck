import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";

type CatalogPickerProps = {
  onCustom: () => void;
};

export default function CatalogPicker({ onCustom }: CatalogPickerProps) {
  const { t } = useTranslation("settings");

  return (
    <Button variant="outline" size="sm" onClick={onCustom}>
      <Plus className="mr-1 h-3.5 w-3.5" />
      {t("pilotDeckConfig.panels.models.customProvider")}
    </Button>
  );
}
