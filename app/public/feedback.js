(() => {
    const TEXT = {
        en: {
            menu: 'Send feedback', issueLabel: 'Describe the issue (optional)', noteLabel: 'Your feedback',
            emailLabel: 'Email (optional)', emailHelp: 'Only if you would like us to reply.',
            saveError: 'Could not save. Your text is still here. Press OK to try again.',
            categoryError: 'Could not save the report. Select the same category again to retry.',
            invalidEmail: 'Please enter a valid email address.',
            sessionLimit: 'This translation session has reached its limit of 500 reports. More reports can be sent in a new session.',
        },
        pl: {
            menu: 'Wyślij opinię', issueLabel: 'Opisz problem (opcjonalnie)', noteLabel: 'Twoja opinia',
            emailLabel: 'Email (opcjonalnie)', emailHelp: 'Tylko jeśli chcesz otrzymać odpowiedź.',
            saveError: 'Nie udało się zapisać. Tekst został zachowany. Naciśnij OK, aby spróbować ponownie.',
            categoryError: 'Nie udało się zapisać zgłoszenia. Wybierz ponownie tę samą kategorię.',
            invalidEmail: 'Wpisz poprawny adres email.',
            sessionLimit: 'W tej sesji tłumaczenia zapisano już 500 zgłoszeń. Kolejne będzie można wysłać w nowej sesji.',
        },
        de: {
            menu: 'Feedback senden', issueLabel: 'Problem beschreiben (optional)', noteLabel: 'Dein Feedback',
            emailLabel: 'E-Mail (optional)', emailHelp: 'Nur wenn du eine Antwort möchtest.',
            saveError: 'Speichern fehlgeschlagen. Dein Text bleibt erhalten. Mit OK erneut versuchen.',
            categoryError: 'Die Meldung konnte nicht gespeichert werden. Wähle dieselbe Kategorie erneut, um es noch einmal zu versuchen.',
            invalidEmail: 'Bitte eine gültige E-Mail-Adresse eingeben.',
            sessionLimit: 'Für diese Übersetzungssitzung wurden bereits 500 Meldungen gespeichert. Weitere Meldungen sind erst in einer neuen Sitzung möglich.',
        },
        fr: {
            menu: 'Envoyer un avis', issueLabel: 'Décrivez le problème (facultatif)', noteLabel: 'Votre avis',
            emailLabel: 'E-mail (facultatif)', emailHelp: 'Seulement si vous souhaitez une réponse.',
            saveError: 'Enregistrement impossible. Votre texte est conservé. Appuyez sur OK pour réessayer.',
            categoryError: 'Le signalement n’a pas pu être enregistré. Sélectionnez à nouveau la même catégorie pour réessayer.',
            invalidEmail: 'Saisissez une adresse e-mail valide.',
            sessionLimit: 'Cette session de traduction a atteint la limite de 500 signalements. Vous pourrez en envoyer d’autres lors d’une nouvelle session.',
        },
        es: {
            menu: 'Enviar comentarios', issueLabel: 'Describe el problema (opcional)', noteLabel: 'Tu comentario',
            emailLabel: 'Correo electrónico (opcional)', emailHelp: 'Solo si deseas una respuesta.',
            saveError: 'No se pudo guardar. Tu texto se conserva. Pulsa OK para reintentar.',
            categoryError: 'No se pudo guardar el aviso. Vuelve a seleccionar la misma categoría para intentarlo de nuevo.',
            invalidEmail: 'Introduce un correo electrónico válido.',
            sessionLimit: 'Se ha alcanzado el límite de 500 avisos para esta sesión de traducción. Podrás enviar más en una nueva sesión.',
        },
        it: {
            menu: 'Invia un commento', issueLabel: 'Descrivi il problema (facoltativo)', noteLabel: 'Il tuo commento',
            emailLabel: 'Email (facoltativa)', emailHelp: 'Solo se desideri una risposta.',
            saveError: 'Salvataggio non riuscito. Il testo è conservato. Premi OK per riprovare.',
            categoryError: 'Impossibile salvare la segnalazione. Seleziona di nuovo la stessa categoria per riprovare.',
            invalidEmail: 'Inserisci un indirizzo email valido.',
            sessionLimit: 'Questa sessione di traduzione ha raggiunto il limite di 500 segnalazioni. Potrai inviarne altre in una nuova sessione.',
        },
        pt: {
            menu: 'Enviar comentário', issueLabel: 'Descreva o problema (opcional)', noteLabel: 'O seu comentário',
            emailLabel: 'Email (opcional)', emailHelp: 'Apenas se desejar uma resposta.',
            saveError: 'Não foi possível guardar. O texto foi mantido. Prima OK para tentar novamente.',
            categoryError: 'Não foi possível guardar a mensagem. Selecione novamente a mesma categoria para voltar a tentar.',
            invalidEmail: 'Introduza um endereço de email válido.',
            sessionLimit: 'Esta sessão de tradução atingiu o limite de 500 mensagens. Poderá enviar mais numa nova sessão.',
        },
        ru: {
            menu: 'Отправить отзыв', issueLabel: 'Опишите проблему (необязательно)', noteLabel: 'Ваш отзыв',
            emailLabel: 'Электронная почта (необязательно)', emailHelp: 'Только если хотите получить ответ.',
            saveError: 'Не удалось сохранить. Текст сохранён в форме. Нажмите OK ещё раз.',
            categoryError: 'Не удалось сохранить сообщение. Выберите ту же категорию ещё раз, чтобы повторить попытку.',
            invalidEmail: 'Введите корректный адрес электронной почты.',
            sessionLimit: 'В этой сессии перевода уже сохранено 500 сообщений. Новые сообщения можно будет отправить в следующей сессии.',
        },
        uk: {
            menu: 'Надіслати відгук', issueLabel: 'Опишіть проблему (необов’язково)', noteLabel: 'Ваш відгук',
            emailLabel: 'Електронна пошта (необов’язково)', emailHelp: 'Лише якщо бажаєте отримати відповідь.',
            saveError: 'Не вдалося зберегти. Текст залишився у формі. Натисніть OK ще раз.',
            categoryError: 'Не вдалося зберегти повідомлення. Виберіть ту саму категорію ще раз, щоб повторити спробу.',
            invalidEmail: 'Введіть коректну адресу електронної пошти.',
            sessionLimit: 'У цій сесії перекладу вже збережено 500 повідомлень. Нові можна буде надіслати в наступній сесії.',
        },
        tr: {
            menu: 'Geri bildirim gönder', issueLabel: 'Sorunu açıklayın (isteğe bağlı)', noteLabel: 'Geri bildiriminiz',
            emailLabel: 'E-posta (isteğe bağlı)', emailHelp: 'Yalnızca yanıt almak istiyorsanız.',
            saveError: 'Kaydedilemedi. Metniniz korundu. Tekrar denemek için OK düğmesine basın.',
            categoryError: 'Bildirim kaydedilemedi. Tekrar denemek için aynı kategoriyi yeniden seçin.',
            invalidEmail: 'Geçerli bir e-posta adresi girin.',
            sessionLimit: 'Bu çeviri oturumunda 500 bildirim sınırına ulaşıldı. Yeni bildirimler bir sonraki oturumda gönderilebilir.',
        },
        sw: {
            menu: 'Tuma maoni', issueLabel: 'Eleza tatizo (si lazima)', noteLabel: 'Maoni yako',
            emailLabel: 'Barua pepe (si lazima)', emailHelp: 'Ikiwa ungependa kupata jibu tu.',
            saveError: 'Imeshindwa kuhifadhi. Maandishi yako bado yapo. Bonyeza OK kujaribu tena.',
            categoryError: 'Imeshindwa kuhifadhi taarifa. Chagua aina hiyo hiyo ya tatizo tena ili kujaribu upya.',
            invalidEmail: 'Weka anwani sahihi ya barua pepe.',
            sessionLimit: 'Kipindi hiki cha tafsiri kimefikia kikomo cha taarifa 500. Unaweza kutuma taarifa nyingine katika kipindi kipya.',
        },
        ar: {
            menu: 'إرسال ملاحظات', issueLabel: 'صف المشكلة (اختياري)', noteLabel: 'ملاحظاتك',
            emailLabel: 'البريد الإلكتروني (اختياري)', emailHelp: 'فقط إذا كنت ترغب في الحصول على رد.',
            saveError: 'تعذر الحفظ. النص محفوظ في النموذج. اضغط OK للمحاولة مجدداً.',
            categoryError: 'تعذر حفظ البلاغ. اختر الفئة نفسها مرة أخرى لإعادة المحاولة.',
            invalidEmail: 'أدخل عنوان بريد إلكتروني صالحاً.',
            sessionLimit: 'تم حفظ 500 بلاغ في جلسة الترجمة هذه. يمكنك إرسال المزيد عند بدء جلسة جديدة.',
        },
    };
    window.feedbackMenuLabel = lang => (TEXT[lang] || TEXT.en).menu;

    window.createListenerFeedback = ({ getContext, getConfig, getLanguage, getIssueTitle }) => {
        const element = id => document.getElementById(id);
        const overlay = element('feedbackOverlay');
        const form = element('feedbackForm');
        const note = element('feedbackNote');
        const email = element('feedbackEmail');
        const errorBox = element('feedbackError');
        const labels = () => TEXT[getLanguage()] || TEXT.en;
        let context;
        let kind;
        let busy = false;
        let attempt = null;
        let closeTimer;
        let returnFocus;
        let previousOverflow;

        function fitViewport() {
            const viewport = window.visualViewport;
            overlay.style.top = `${viewport?.offsetTop || 0}px`;
            overlay.style.height = `${viewport?.height || window.innerHeight}px`;
            overlay.style.setProperty('--feedback-height', overlay.style.height);
        }

        function open(nextKind) {
            clearTimeout(closeTimer);
            kind = nextKind;
            context = { ...getContext(), occurredAt: new Date().toISOString() };
            attempt = null;
            returnFocus = kind === 'issue' ? element('feedbackTrigger') : element('menuToggle');
            form.reset();
            form.hidden = true;
            errorBox.hidden = true;
            element('feedbackTitle').textContent = getIssueTitle();
            element('feedbackOptions').style.display = 'block';
            element('feedbackThanks').style.display = 'none';
            previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            overlay.classList.add('open');
            fitViewport();
            if (kind === 'general_feedback') showEditor();
            else overlay.querySelector('.feedback-option').focus();
        }

        function close() {
            if (busy) return;
            clearTimeout(closeTimer);
            overlay.classList.remove('open');
            document.body.style.overflow = previousOverflow || '';
            form.reset();
            returnFocus?.focus({ preventScroll: true });
        }

        function showEditor() {
            const general = kind === 'general_feedback';
            const strings = labels();
            element('feedbackTitle').textContent = general ? strings.menu : getIssueTitle();
            element('feedbackOptions').style.display = 'none';
            element('feedbackContact').hidden = !general;
            element('feedbackEmailLabel').textContent = strings.emailLabel;
            element('feedbackEmailHelp').textContent = strings.emailHelp;
            element('feedbackNoteLabel').textContent = general ? strings.noteLabel : strings.issueLabel;
            form.hidden = false;
            form.classList.toggle('general', general);
            note.maxLength = general ? 3000 : 200;
            updateCount();
            note.focus({ preventScroll: true });
            note.scrollIntoView?.({ block: 'nearest' });
        }

        function updateCount() {
            if (note.value.length > note.maxLength) {
                note.value = note.value.slice(0, note.maxLength).replace(/[\uD800-\uDBFF]$/, '');
            }
            element('feedbackCount').textContent = `${note.value.length} / ${note.maxLength}`;
        }

        function setBusy(value) {
            busy = value;
            overlay.setAttribute('aria-busy', String(value));
            overlay.querySelectorAll('button, textarea, input').forEach(control => { control.disabled = value; });
        }

        function reportPayload(reason) {
            const report = {
                ...context, kind, reason,
                note: form.hidden ? null : note.value.trim() || null,
                email: kind === 'general_feedback' ? email.value.trim() || null : null,
            };
            const serialized = JSON.stringify(report);
            if (attempt?.serialized !== serialized) attempt = { serialized, reportId: crypto.randomUUID() };
            return { ...report, reportId: attempt.reportId };
        }

        async function send(reason) {
            if (busy) return;
            const payload = reportPayload(reason);
            if (kind === 'general_feedback' && !payload.note && !payload.email) return close();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            errorBox.hidden = true;
            setBusy(true);
            try {
                const url = getConfig().url;
                if (!url) throw new Error('Feedback endpoint unavailable');
                const response = await fetch(url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    credentials: 'omit', cache: 'no-store', signal: controller.signal,
                    body: JSON.stringify(payload),
                });
                const result = await response.json();
                if (!response.ok) throw Object.assign(new Error('Feedback not saved'), { code: result.code });
                if (!result.success || result.reportId !== payload.reportId) throw new Error('Missing receipt');
                setBusy(false);
                if (!form.hidden) close();
                else {
                    element('feedbackOptions').style.display = 'none';
                    element('feedbackThanks').style.display = 'block';
                    closeTimer = setTimeout(close, 1200);
                }
            } catch (error) {
                const strings = labels();
                if (error.code === 'session_limit') errorBox.textContent = strings.sessionLimit;
                else if (error.code === 'invalid_email') errorBox.textContent = strings.invalidEmail;
                else errorBox.textContent = form.hidden ? strings.categoryError : strings.saveError;
                errorBox.hidden = false;
            } finally {
                clearTimeout(timeout);
                setBusy(false);
            }
        }

        form.addEventListener('submit', event => {
            event.preventDefault();
            if (busy) return;
            if (!email.checkValidity()) {
                errorBox.textContent = labels().invalidEmail;
                errorBox.hidden = false;
                email.focus();
                return;
            }
            if (note.value.length > note.maxLength) return;
            send(kind === 'issue' ? 'other' : null);
        });
        note.addEventListener('input', updateCount);
        window.visualViewport?.addEventListener('resize', fitViewport);
        window.visualViewport?.addEventListener('scroll', fitViewport);
        window.addEventListener('resize', fitViewport);
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); close(); }
            if (event.key !== 'Tab') return;
            const controls = [...overlay.querySelectorAll('button, input, textarea')]
                .filter(control => !control.disabled && control.getClientRects().length);
            const target = event.shiftKey ? controls.at(-1) : controls[0];
            const boundary = event.shiftKey ? controls[0] : controls.at(-1);
            if (document.activeElement === boundary) { event.preventDefault(); target?.focus(); }
        });

        return {
            open, close,
            choose(reason) {
                if (busy) return;
                if (reason === 'other') showEditor();
                else send(reason);
            },
        };
    };
})();
