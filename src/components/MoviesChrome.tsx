import BrowseModeSwitch, { type BrowseMode } from "./BrowseModeSwitch";
import { Button } from "./ios/controls";
import { IChevR, IGrid } from "../icons";

export function MoviesPageHeader({
  mode,
  onChange,
  summary,
}: {
  mode: BrowseMode;
  onChange: (mode: BrowseMode) => void;
  summary: string;
}) {
  return (
    <header className="ios-page-heading movies-page-header shrink-0 px-4" data-ui="movies-header">
      <div className="flex min-w-0 items-end gap-2.5">
        <h1 className="ios-page-title text-on">影视</h1>
        <span className="movies-page-summary" data-ui="movies-header-summary">{summary}</span>
      </div>
      <BrowseModeSwitch mode={mode} onChange={onChange} />
      <p className="movies-header-note" data-ui="movies-header-note">
        HGhubX 频道与 TVBox 聚合源统一从这里切换
      </p>
    </header>
  );
}

export function MoviesShelfHeading({
  title,
  subtitle,
  actionLabel,
  actionAriaLabel,
  onAction,
}: {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  onAction?: () => void;
}) {
  const content = (
    <>
      <span className="movies-shelf-icon" data-ui="movies-shelf-icon" aria-hidden="true">
        <IGrid size={19} strokeWidth={1.9} />
      </span>
      <span className="movies-shelf-copy">
        <span className="movies-shelf-title" data-ui="movies-shelf-title" role="heading" aria-level={2}>{title}</span>
        {subtitle && <span className="movies-shelf-subtitle">{subtitle}</span>}
      </span>
      {actionLabel && onAction ? (
        <span className="movies-shelf-more" data-ui="movies-shelf-more">
          {actionLabel}<IChevR size={14} />
        </span>
      ) : <span className="movies-shelf-more-spacer" aria-hidden="true" />}
    </>
  );

  return (
    actionLabel && onAction
      ? <Button onClick={onAction} aria-label={actionAriaLabel ?? `${actionLabel}${title}`}
        className="movies-shelf-heading movies-shelf-heading-button pressable">{content}</Button>
      : <div className="movies-shelf-heading">{content}</div>
  );
}
