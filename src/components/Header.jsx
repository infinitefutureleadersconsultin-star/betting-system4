export default function Header() {
  return (
    <header className="bg-dark-card border-b border-gray-700">
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-betting-green">
              Master Betting System
            </h1>
            <p className="text-gray-400 mt-1">
              Advanced Analytics for Player Props & Game Lines
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <span className="w-2 h-2 bg-betting-green rounded-full" />
            <span className="text-betting-green">Online</span>
          </div>
        </div>
      </div>
    </header>
  )
}
