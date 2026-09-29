
        // Firebase Configuration
        const firebaseConfig = {
            apiKey: "AIzaSyBOwNS9wtWsT6XZTyYMr6lInkB0KLYNFRw",
            authDomain: "hsabaty-app.firebaseapp.com",
            projectId: "hsabaty-app",
            storageBucket: "hsabaty-app.firebasestorage.app",
            messagingSenderId: "694389022438",
            appId: "1:694389022438:web:b7a2978e00b5d8da592527"
        };
        
        // Initialize Firebase
        if (typeof firebase !== 'undefined') {
            firebase.initializeApp(firebaseConfig);
        }
    