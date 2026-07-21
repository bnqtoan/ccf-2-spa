import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import './components.css'

interface FieldWrapperProps {
  label?: string
  hint?: string
  error?: string
  id?: string
}

export interface FieldInputProps
  extends FieldWrapperProps,
    Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  as?: 'input'
}

export interface FieldSelectProps
  extends FieldWrapperProps,
    Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  as: 'select'
  children: ReactNode
}

export type FieldProps = FieldInputProps | FieldSelectProps

let idCounter = 0
function useStableId(id?: string) {
  if (id) return id
  idCounter += 1
  return `ccf-field-${idCounter}`
}

/**
 * Port từ .field (input/select), focus state viền xanh
 * (prototype/index.html dòng 152-161).
 *
 * type="tel" (số điện thoại) hỗ trợ như mọi input type khác qua props.
 */
export default function Field(props: FieldProps) {
  const { label, hint, error, id, className, ...rest } = props
  const fieldId = useStableId(id)
  const inputClasses = ['ccf-field-input', error && 'ccf-field-input--error', className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="ccf-field">
      {label && <label htmlFor={fieldId}>{label}</label>}
      {props.as === 'select' ? (
        <select id={fieldId} className={inputClasses} {...(rest as SelectHTMLAttributes<HTMLSelectElement>)}>
          {props.children}
        </select>
      ) : (
        <input id={fieldId} className={inputClasses} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
      )}
      {error ? (
        <div className="ccf-hint ccf-hint--error">{error}</div>
      ) : hint ? (
        <div className="ccf-hint">{hint}</div>
      ) : null}
    </div>
  )
}
