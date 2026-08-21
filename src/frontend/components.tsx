import React from 'react';
import { SettingsView } from '../shared/types.js';

export interface Option {
  value: string;
  label: string;
}

/** A labeled dropdown with an optional "+" add button. */
export function FieldSelect(props: {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  onAdd: () => void;
}): React.ReactElement {
  return (
    <div className="field">
      <label className="flabel">{props.label}</label>
      <span className="fgrow">
        <select
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="" disabled>
            선택...
          </option>
          {props.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="mini add" title="추가" onClick={props.onAdd}>
          +
        </button>
      </span>
    </div>
  );
}

/** A plain labeled text input. */
export function FieldText(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="field">
      <label className="flabel">{props.label}</label>
      <input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </div>
  );
}

/** DATA_ROOT status + "변경" action shown in the header. */
export function DataRootWidget(props: {
  settings: SettingsView | null;
  onChanged: (s: SettingsView) => void;
  onPick: () => void;
}): React.ReactElement {
  const has = !!(props.settings && props.settings.dataRoot);
  return (
    <div className="datameta" title={props.settings?.dataRoot ?? ''}>
      <span className={`dot ${has ? 'on' : 'off'}`}></span>
      <span className="clamp">
        {has ? props.settings!.dataRoot : 'DATA_ROOT 미지정'}
      </span>
      <button className="mini add" onClick={props.onPick}>
        변경
      </button>
    </div>
  );
}