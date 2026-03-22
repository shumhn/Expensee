import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [theme, setThemeState] = useState<Theme>('dark');

    useEffect(() => {
        // Dark mode is enforced app-wide.
        setThemeState('dark');
    }, []);

    useEffect(() => {
        // Apply theme to html element
        const root = window.document.documentElement;
        root.setAttribute('data-theme', 'dark');
        root.classList.add('dark');
        localStorage.setItem('theme', 'dark');
    }, [theme]);

    const toggleTheme = () => {
        setThemeState('dark');
    };

    const setTheme = (_newTheme: Theme) => {
        setThemeState('dark');
    };

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
