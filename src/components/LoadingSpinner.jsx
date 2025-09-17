export default function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-betting-green"></div>
      <div className="ml-4">
        <p className="text-betting-green font-medium">Analyzing...</p>
        <p className="text-gray-400 text-sm">Running statistical models</p>
      </div>
    </div>
  )
}
