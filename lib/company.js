// Company details printed on every document (footer) and shown in the live preview.
const NAME = 'PT. Balla Sultana Samata';
const ADDRESS = 'Jl. Paraikatte, Romang Polong, Kec. Somba Opu, Kab. Gowa, Sulawesi Selatan';
const PHONE = '0877-8575-8656';
const EMAIL = 'admin@sultanaliving.id';

module.exports = {
  NAME, ADDRESS, PHONE, EMAIL,
  footerText: `${NAME}  •  ${ADDRESS}  •  Telp/WA ${PHONE}  •  ${EMAIL}`,
};
