import * as RadixSlider from '@radix-ui/react-slider';

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <RadixSlider.Root
      className="slider"
      value={[value]}
      onValueChange={([v]) => v !== undefined && onChange(v)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
    >
      <RadixSlider.Track className="slider-track">
        <RadixSlider.Range className="slider-range" />
      </RadixSlider.Track>
      <RadixSlider.Thumb className="slider-thumb" aria-label={ariaLabel} />
    </RadixSlider.Root>
  );
}
