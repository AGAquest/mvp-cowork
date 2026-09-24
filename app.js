document.addEventListener('DOMContentLoaded', () => {
    const bookingForm = document.getElementById('booking-form');
    const bookingsList = document.getElementById('bookings-list');
    const emptyState = document.getElementById('empty-state');

    // Cargar reservas desde LocalStorage o crear un arreglo vacío
    let bookings = JSON.parse(localStorage.getItem('cowork_bookings')) || [];

    // Función para renderizar la lista en pantalla
    function renderBookings() {
        bookingsList.innerHTML = '';
        
        if (bookings.length === 0) {
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
            
            bookings.forEach((booking, index) => {
                const li = document.createElement('li');
                li.className = 'border-l-4 border-blue-500 bg-gray-50 p-4 rounded-r-md flex justify-between items-start';
                
                li.innerHTML = `
                    <div>
                        <h3 class="font-bold text-gray-800">${booking.projectName}</h3>
                        <p class="text-sm text-gray-600">${booking.spaceType}</p>
                        <p class="text-xs text-gray-500 mt-1">📅 ${booking.date}</p>
                    </div>
                    <button onclick="deleteBooking(${index})" class="text-red-500 hover:text-red-700 text-sm font-medium">
                        Cancelar
                    </button>
                `;
                bookingsList.appendChild(li);
            });
        }
    }

    // Manejar el evento de enviar el formulario
    bookingForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const newBooking = {
            projectName: document.getElementById('project-name').value,
            spaceType: document.getElementById('space-type').value,
            date: document.getElementById('booking-date').value
        };

        // Agregar al arreglo y guardar en LocalStorage
        bookings.push(newBooking);
        localStorage.setItem('cowork_bookings', JSON.stringify(bookings));

        // Limpiar formulario y actualizar vista
        bookingForm.reset();
        renderBookings();
    });

    // Función para eliminar reserva (debe ser global para el onclick del HTML)
    window.deleteBooking = function(index) {
        bookings.splice(index, 1);
        localStorage.setItem('cowork_bookings', JSON.stringify(bookings));
        renderBookings();
    };

    // Render inicial al cargar la página
    renderBookings();
});