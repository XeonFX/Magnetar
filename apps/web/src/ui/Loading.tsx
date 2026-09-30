/** A spinner while a page (`screen`) or a section loads. */
export function Loading({ screen = false }: { screen?: boolean }) {
  return (
    <div className={screen ? 'grid min-h-screen place-items-center' : 'flex justify-center py-20'}>
      <span className="loading loading-spinner loading-lg text-primary" />
    </div>
  )
}
