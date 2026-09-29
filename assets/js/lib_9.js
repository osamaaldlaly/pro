
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Cairo', 'sans-serif']
                    },
                    colors: {
                        dark: {
                            bg: '#111827',
                            card: '#1f2937',
                            border: '#374151',
                            text: '#f3f4f6'
                        }
                    },
                    screens: {
                        'print': { 'raw': 'print' }
                    }
                }
            }
        }
        
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.classList.add('dark');
        }
    