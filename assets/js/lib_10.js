
window.hideAppLoader = function hideAppLoader() {
    var loader = document.getElementById('app-loader');
    if (!loader) return;
    if (loader.classList.contains('app-loader-hidden')) return;
    loader.classList.add('app-loader-hidden');
    setTimeout(function () { loader.style.display = 'none'; }, 400);
};

// احتياطي أمان: إخفاء الشاشة بعد 10 ثوانٍ في حال حدوث خطأ غير متوقع يمنع التطبيق من العمل
setTimeout(function () {
    if (typeof window.hideAppLoader === 'function') {
        window.hideAppLoader();
    }
}, 10000);

        window.onerror = function(message) {
            document.body.innerHTML = '<div style="padding:20px;text-align:center;color:red;"><h3>حدث خطأ</h3><p>' + message + '</p></div>';
            return true;
        };
    