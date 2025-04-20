function isValidEmail(email) {
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return regex.test(email);
}

function isValidPhone(phone) {
    const regex = /^(\+359|0)8[7-9][0-9]{7}$/;
    return regex.test(phone);
}

function isValidPassword(password) {
    return password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

const form = document.getElementById('registration-form');
const emailInput = document.getElementById('email');
const phoneInput = document.getElementById('phone');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirm_password');

const emailError = document.getElementById('email-error');
const phoneError = document.getElementById('phone-error');
const passwordError = document.getElementById('password-error');
const confirmPasswordError = document.getElementById('confirm_password-error');
const serverMessageDiv = document.getElementById('server-message');

emailError.style.display = 'none';
phoneError.style.display = 'none';
passwordError.style.display = 'none';
confirmPasswordError.style.display = 'none';

form.addEventListener('submit', async (event) => {
    event.preventDefault();

    emailError.style.display = 'none';
    phoneError.style.display = 'none';
    passwordError.style.display = 'none';
    confirmPasswordError.style.display = 'none';
    serverMessageDiv.style.display = 'none';
    serverMessageDiv.textContent = '';
    serverMessageDiv.className = '';

    let isValid = true;

    if (!isValidEmail(emailInput.value)) {
        emailError.style.display = 'block';
        isValid = false;
    }

    if (!isValidPhone(phoneInput.value)) {
        phoneError.style.display = 'block';
        isValid = false;
    }

    if (!isValidPassword(passwordInput.value)) {
        passwordError.style.display = 'block';
        isValid = false;
    }

    if (passwordInput.value !== confirmPasswordInput.value) {
        confirmPasswordError.style.display = 'block';
        isValid = false;
    }

    if (isValid) {
        try {
            const formData = new FormData(form);
            const response = await fetch('/register', {
                method: 'POST',
                body: new URLSearchParams(formData)
            });

            const result = await response.json();

            serverMessageDiv.textContent = result.message;
            serverMessageDiv.className = result.status;
            serverMessageDiv.style.display = 'block';

            if (result.status === 'success' || result.status === 'info') {
                form.reset();
            }

        } catch (error) {
            console.error("Грешка при изпращане на формата:", error);
            serverMessageDiv.textContent = "Възникна грешка при комуникацията със сървъра.";
            serverMessageDiv.className = 'error';
            serverMessageDiv.style.display = 'block';
        }
    } else {

        serverMessageDiv.textContent = "Моля, коригирайте грешките във формата.";
        serverMessageDiv.className = 'error';
        serverMessageDiv.style.display = 'block';
    }
});