import { CopyButton } from './copy-button'
import { Textarea } from './textarea'

export const ObservableCellsCopy = ({ cells }: { cells: string[] }) => {
  // TODO add logic for copying all cells - inspired by https://observablehq.com/@tophtucker/generate-copied-cells
  // const allCells = JSON.stringify(
  //   cells.map((cell, i) => ({
  //     id: i,
  //     value: cell,
  //     pinned: true,
  //     mode: 'js',
  //     data: null,
  //     name: `Cell ${i}`,
  //   })),
  // )
  return (
    <div className="flex flex-col gap-2">
      {cells.map((cell) => (
        <div className="flex items-center gap-2">
          <Textarea
            disabled
            value={cell}
            className="bg-gray-100 font-mono text-[10px] h-24"
          />
          <CopyButton value={cell} className="h-9 w-9" />
        </div>
      ))}
      {/* <CopyButton
        value={allCells}
        className="h-9 w-9"
        label="Copy all"
        onClickOverride={(e) => {
          e.clipboardData.setData("text/plain", cells.join("\n\n"));
          e.clipboardData.setData("application/vnd.observablehq+json", allCells);
          e.preventDefault();
        }}
      /> */}
    </div>
  )
}
