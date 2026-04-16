import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { User, LogOut, Coins } from 'lucide-react';

export function UserMenu() {
  const { user, creditBalance, signOut, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) return null;

  if (!user) {
    return (
      <Button variant="outline" size="sm" onClick={() => navigate('/auth')}>
        Sign In
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
        <Coins className="h-3.5 w-3.5" />
        {creditBalance}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <User className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="text-xs text-muted-foreground">{user.email}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { signOut(); navigate('/'); }}>
            <LogOut className="h-4 w-4 mr-2" /> Sign Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
