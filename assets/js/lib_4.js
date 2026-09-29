
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/service-worker.js')
                .then(registration => {
                    console.log('ServiceWorker registered:', registration.scope);
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        console.log('Service Worker update found!');
                    });
                })
                .catch(error => {
                    console.log('ServiceWorker registration failed:', error);
                });
            });
        }
    